import { call } from 'effection';
import type { Operation } from 'effection';
import { Tool, Trace } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema, ToolContext } from '@lloyal-labs/lloyal-agents';
import type { Chunk } from '@lloyal-labs/rig';
import type { Reranker, ScoredChunk } from '@lloyal-labs/rig';
import { BM25Index } from '../bm25';

/**
 * Default score floor for search hits — a useful **discrimination signal**,
 * not an absolute relevance line.
 *
 * Scores are log-odds of the reranker's absolute yes/no relevance judgment:
 * `P(yes) = sigmoid(score)`, so this floor of 0 means "keep documents the
 * model judges more-likely-relevant-than-not" (P ≥ 0.5). The official
 * Qwen3-Reranker scoring is the two-token softmax over {yes,no} — our
 * log-odds is its monotone equivalent (identical rankings, unbounded scale).
 * Top-1 routinely goes negative on real corpora when no document is strongly
 * relevant — an honest "probably not" — and rankings still work. The point
 * of the threshold is to give the agent **two distinct signals**:
 *
 * - `hits` ≥ threshold ⇒ the model produced confident matches; treat as
 *   high-quality retrieval.
 * - `hits = []` + `topRejected` populated ⇒ the model didn't find anything
 *   confident; the topRejected entries are "best I could find but I don't
 *   stand behind any of them," and the agent can either use them with
 *   reduced confidence or report "no good matches" honestly.
 *
 * The default `0` is empirically useful on the corpora HDK ships against —
 * not a derivation from "positive logit-diff = relevant." Override via
 * `opts.threshold` for corpora where calibration suggests a different floor;
 * or pass `-Infinity` to bypass the discrimination and always return top-K
 * (lets the agent see all candidates regardless of confidence).
 */
const DEFAULT_THRESHOLD = 0;

/**
 * Default first-stage retrieval cap. The cross-encoder reranker is O(N) in
 * candidate count; BM25 narrows to the top-K lexical matches so the
 * cross-encoder only scores promising candidates. K=100 is generous: BM25
 * catches the lexical bouncer signal, leaving the cross-encoder to
 * disambiguate semantics within the top-K. Set to `Infinity` to disable
 * first-stage (useful for small corpora / tests).
 */
const DEFAULT_FIRST_STAGE_K = 100;

/**
 * Semantic search over corpus chunks via BM25 → cross-encoder Reranker.
 *
 * Two-stage retrieval:
 *   1. BM25 (lexical) first-stage: index built once at constructor time over
 *      `chunk.tokens`. At query time, tokenize the query through the
 *      reranker's tokenizer, score every chunk by Okapi-BM25, take top-K.
 *   2. Cross-encoder rerank: pass the top-K subset to {@link Reranker.score}
 *      for semantic re-scoring. Returns ranked results with file names,
 *      headings, scores, and line ranges.
 *
 * The BM25 stage caps cross-encoder work at `firstStageK` cross-encoder
 * forward passes regardless of corpus size, delivering the load-bearing
 * latency improvement at the cost of a recall ceiling (BM25 lexical
 * matching, not semantic). Mitigation: K=100 default is wide enough that
 * the cross-encoder's eventual winners are typically in the BM25 top-K.
 *
 * Output is a `{hits, thresholdScore, totalScored, topRejected}` envelope —
 * NOT a raw array. `totalScored` reflects the BM25 candidate pool that
 * actually got cross-encoded, not the whole corpus, so the agent sees the
 * effective pool size honestly.
 *
 * @example
 * ```typescript
 * const search = new SearchTool(chunks, reranker);
 * // Or with a corpus-specific floor + larger first-stage:
 * const search = new SearchTool(chunks, reranker, { threshold: 1.5, firstStageK: 200 });
 * // Or to bypass BM25 (small corpus / tests):
 * const search = new SearchTool(chunks, reranker, { firstStageK: Infinity });
 * ```
 *
 * @category Rig
 */
export class SearchTool extends Tool<{ query: string }> {
  readonly name = 'search';
  readonly protected = false;
  // Reranker (its own llama_context, _inflight-serialized) + in-memory BM25 —
  // no op on the MAIN context, so it runs off the loop fiber under concurrent
  // dispatch. See Tool.fanout.
  readonly fanout = true;
  readonly description = 'Search the knowledge base. Returns sections ranked by relevance with line ranges for read_file.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query' } },
    required: ['query'],
  };

  private _chunks: Chunk[];
  private _reranker: Reranker;
  private _threshold: number;
  private _firstStageK: number;
  /** Lazy BM25 index — built on first execute() call, after chunks are
   *  guaranteed tokenized. Constructing here would race tokenizeChunks(). */
  private _bm25: BM25Index | null = null;

  constructor(
    chunks: Chunk[],
    reranker: Reranker,
    opts?: { threshold?: number; firstStageK?: number },
  ) {
    super();
    this._chunks = chunks;
    this._reranker = reranker;
    this._threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
    this._firstStageK = opts?.firstStageK ?? DEFAULT_FIRST_STAGE_K;
  }

  *execute(args: { query: string }, context?: ToolContext): Operation<unknown> {
    const query = args.query?.trim();
    if (!query) return { error: 'query must not be empty' };
    const tw = yield* Trace.expect();
    const reranker = this._reranker;
    const chunks = this._chunks;

    // ── Stage 1: BM25 first-stage ──────────────────────────────
    // Tokenize the query through the reranker's tokenizer so it shares
    // vocabulary with the chunks' tokens (built at corpus boot via
    // tokenizeChunks).
    let candidates: Chunk[] = chunks;
    if (this._firstStageK < chunks.length) {
      const bm25Start = performance.now();
      tw.write({
        traceId: tw.nextId(), parentTraceId: null, ts: bm25Start,
        type: 'bm25:start',
        query,
        candidateCount: chunks.length,
        firstStageK: this._firstStageK,
      });

      // Build index on first use — by now tokenizeChunks has populated tokens.
      if (this._bm25 === null) {
        const docTokens = chunks.map((c) => c.tokens);
        this._bm25 = new BM25Index(docTokens);
      }

      const queryTokens: number[] = yield* call(() => reranker.tokenize(query));
      const hits = this._bm25.score(queryTokens, this._firstStageK);
      candidates = hits.map((h) => chunks[h.index]);

      tw.write({
        traceId: tw.nextId(), parentTraceId: null, ts: performance.now(),
        type: 'bm25:end',
        candidateCount: chunks.length,
        keptCount: candidates.length,
        durationMs: performance.now() - bm25Start,
      });
    }

    // ── Stage 2: cross-encoder rerank ──────────────────────────
    const t0 = performance.now();
    tw.write({
      traceId: tw.nextId(), parentTraceId: null, ts: t0,
      type: 'rerank:start', query, chunkCount: candidates.length,
    });

    // `reranker.score` yields a topK-truncated `results` array but the
    // `total` field carries the actual candidate count that was scored.
    // We need `total` to populate `totalScored` honestly.
    let scoredCount = 0;
    let results: ScoredChunk[] = yield* call(async () => {
      let last: ScoredChunk[] = [];
      for await (const { results, filled, total } of reranker.score(query, candidates)) {
        if (context?.onProgress) context.onProgress({ filled, total });
        last = results;
        scoredCount = total;
      }
      return last;
    });

    // Explore mode (default): agent-local scoring only. Agents discover
    // bridging content (adjacent sections connecting investigation to answer).
    // Scoring against the original query would demote exactly that content.
    //
    // Exploit mode (!explore): dual scoring via scoreRelevanceBatch —
    // min(toolQueryScore, originalQueryScore) per chunk. Tightens focus
    // when KV headroom is low, at the cost of serendipitous discovery.
    if (!context?.explore && context?.scorer && results.length > 0) {
      type ScoredWithOriginal = ScoredChunk & { _toolQueryScore: number };
      const chunkTexts = results.map((sc) => {
        const chunk = chunks.find(c => c.resource === sc.file && c.startLine === sc.startLine);
        return chunk?.text ?? '';
      });
      const combinedScores: number[] = yield* call(() =>
        context.scorer!.scoreRelevanceBatch(chunkTexts, query),
      );
      const reordered: ScoredWithOriginal[] = results
        .map((sc, i) => ({ ...sc, score: combinedScores[i], _toolQueryScore: sc.score }))
        .sort((a, b) => b.score - a.score);
      results = reordered;

      tw.write({
        traceId: tw.nextId(), parentTraceId: null, ts: performance.now(),
        type: 'entailment:content:exploit', tool: 'search',
        pressure: {
          percentAvailable: context.pressurePercentAvailable ?? -1,
          remaining: -1,
          nCtx: -1,
        },
        chunks: reordered.slice(0, 5).map((sc) => ({
          heading: sc.heading,
          toolQueryScore: sc._toolQueryScore,
          combinedScore: sc.score,
        })),
      });
    }

    // Threshold filter: drop hits below the configured score floor. If
    // everything is below the floor, return [] and surface the top 3
    // rejected hits in the envelope so the agent sees "best I could find,
    // but the model said no to all of them" rather than getting fed
    // garbage as if it were honest signal.
    const thresholdScore = this._threshold;
    const totalScored = scoredCount;
    const passing = results.filter(r => r.score >= thresholdScore);
    const topRejected = passing.length === 0 ? results.slice(0, 3) : [];

    tw.write({
      traceId: tw.nextId(), parentTraceId: null, ts: performance.now(),
      type: 'rerank:end',
      topResults: passing.slice(0, 5).map(r => ({ file: r.file, heading: r.heading, score: r.score })),
      selectedPassageCount: passing.length,
      totalChars: 0,
      durationMs: performance.now() - t0,
    });

    return { hits: passing, thresholdScore, totalScored, topRejected };
  }
}
