import { call } from 'effection';
import type { Operation } from 'effection';
import { Tool, Trace, admitChunks } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema, ToolContext } from '@lloyal-labs/lloyal-agents';
import type { Chunk } from '@lloyal-labs/rig';
import type { Reranker } from '@lloyal-labs/rig';
import { BM25Index } from '@lloyal-labs/rig';

/**
 * How many passages a search returns: the top K within a token budget.
 *
 * There is no score floor. The reranker is a RELATIVE judge — its scale shifts
 * from query to query, and its top-ranked candidate goes negative routinely on
 * a corpus that answers the question perfectly well. A floor at zero therefore
 * returned nothing precisely when the agent most needed the best available
 * passages, and a consolation list of "best I could find, but I said no to all
 * of them" existed only to paper over that. Rank the candidates, spend the
 * budget on the best of them, and let the agent read them with their scores.
 */
const DEFAULT_TOP_K = 5;
const DEFAULT_TOKEN_BUDGET = 2048;

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
 * Output is a `{hits, totalScored}` envelope — NOT a raw array. Each hit keeps
 * its file and line range, which is what `read_file` takes. `totalScored`
 * reflects the BM25 candidate pool that actually got cross-encoded, not the
 * whole corpus, so the agent sees the effective pool size honestly.
 *
 * @example
 * ```typescript
 * const search = new SearchTool(chunks, reranker);
 * // Or with a wider answer and a larger first stage:
 * const search = new SearchTool(chunks, reranker, { topK: 8, firstStageK: 200 });
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
  private _topK: number;
  private _tokenBudget: number;
  private _firstStageK: number;
  /** Lazy BM25 index — built on first execute() call, after chunks are
   *  guaranteed tokenized. Constructing here would race tokenizeChunks(). */
  private _bm25: BM25Index | null = null;

  constructor(
    chunks: Chunk[],
    reranker: Reranker,
    opts?: { topK?: number; tokenBudget?: number; firstStageK?: number },
  ) {
    super();
    this._chunks = chunks;
    this._reranker = reranker;
    this._topK = opts?.topK ?? DEFAULT_TOP_K;
    this._tokenBudget = opts?.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
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

    // ── Stage 2: cross-encoder rerank via the platform's admission
    // pipeline. `admitChunks` owns scoring (with progress), explore/exploit
    // dual scoring, the selection gate, and the trace events that make the
    // funnel observable (rerank:start/end, entailment:content:exploit) —
    // this tool owns only what is corpus-shaped: the BM25 first stage and
    // the hits envelope.
    // Always explore, whatever the run's stance. Exploit re-scores every window
    // against the ORIGINAL question and re-sorts by min(), and that was measured
    // vetoing the answer: on the pharmacology thread at q8_0 KV the passage
    // carrying it went +5.5 in explore to −5.0 in exploit. Under a top-K cut a
    // demotion IS an exclusion. The corpus the agent chose to search is its
    // on-topic universe; exploit exists to keep off-topic WEB pages out.
    const admitted = yield* admitChunks(reranker, candidates, query, context ? { ...context, explore: true } : context, {
      tool: 'search',
      select: { mode: 'budget', topK: this._topK, tokenBudget: this._tokenBudget },
    });

    // The budget decides how many; the hits keep their addresses, because
    // `read_file` is addressed by file and line range and a passage's verbatim
    // text is not. The selection is a prefix of the ranking (every corpus chunk
    // has text), so the first `passages.length` scored chunks are the passages.
    const kept = admitted.passages?.length ?? 0;
    return {
      hits: admitted.scored.slice(0, kept),
      totalScored: admitted.totalScored,
    };
  }
}
