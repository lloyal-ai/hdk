import { call } from 'effection';
import type { Operation } from 'effection';
import { Tool, Trace } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema, ToolContext } from '@lloyal-labs/lloyal-agents';
import type { Chunk } from '@lloyal-labs/rig';
import type { Reranker, ScoredChunk } from '@lloyal-labs/rig';

/**
 * Default score floor for search hits. Reranker scores are logit-diffs
 * (`logit(yes) − logit(no)`); a value `> 0` means the cross-encoder model
 * would emit "yes" rather than "no" when asked if the document matches
 * the query. Below 0 ⇒ the model leans toward "no" ⇒ the hit is dropped
 * from `hits` and surfaced in `topRejected` only when nothing else
 * passes (so the agent gets an honest "best I could find" view).
 *
 * Override via the constructor `opts.threshold` for corpora where
 * calibration suggests a different floor.
 */
const DEFAULT_THRESHOLD = 0;

/**
 * Semantic search over corpus chunks via a {@link Reranker}
 *
 * Scores all chunks against the query and returns ranked results
 * with file names, headings, scores, and line ranges. Progress is
 * reported through the optional {@link ToolContext.onProgress}
 * callback as the reranker streams intermediate results.
 *
 * Output is a `{hits, thresholdScore, totalScored, topRejected}`
 * envelope, not a raw array — the threshold gives the agent an
 * honest "0 hits above the floor" signal instead of forcing top-K
 * back regardless of relevance.
 *
 * @example
 * ```typescript
 * const search = new SearchTool(chunks, reranker);
 * // Or with a corpus-specific floor:
 * const search = new SearchTool(chunks, reranker, { threshold: 1.5 });
 * ```
 *
 * @category Rig
 */
export class SearchTool extends Tool<{ query: string }> {
  readonly name = 'search';
  readonly protected = false;
  readonly description = 'Search the knowledge base. Returns sections ranked by relevance with line ranges for read_file.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query' } },
    required: ['query'],
  };

  private _chunks: Chunk[];
  private _reranker: Reranker;
  private _threshold: number;

  constructor(chunks: Chunk[], reranker: Reranker, opts?: { threshold?: number }) {
    super();
    this._chunks = chunks;
    this._reranker = reranker;
    this._threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
  }

  *execute(args: { query: string }, context?: ToolContext): Operation<unknown> {
    const query = args.query?.trim();
    if (!query) return { error: 'query must not be empty' };
    const tw = yield* Trace.expect();
    const reranker = this._reranker;
    const chunks = this._chunks;

    const t0 = performance.now();
    tw.write({
      traceId: tw.nextId(), parentTraceId: null, ts: t0,
      type: 'rerank:start', query, chunkCount: chunks.length,
    });

    // `reranker.score` yields a topK-truncated `results` array but the
    // `total` field carries the actual corpus chunk count that was scored.
    // We need `total` to populate `totalScored` honestly (otherwise the
    // envelope would report `totalScored: 10` because that's the topK cap).
    let scoredCount = 0;
    let results: ScoredChunk[] = yield* call(async () => {
      let last: ScoredChunk[] = [];
      for await (const { results, filled, total } of reranker.score(query, chunks)) {
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
