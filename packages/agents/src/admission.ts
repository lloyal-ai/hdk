import { call } from 'effection';
import type { Operation } from 'effection';
import { Trace } from './context';
import type { Chunk, Reranker, ScoredChunk } from './chunk';
import type { ToolContext } from './types';

/**
 * Selection policy for {@link admitChunks} — the two admission disciplines
 * the platform ships:
 *
 * - `budget` — top-K within a token budget (page-content style: the caller
 *   fetched one resource and wants the most relevant passages that fit).
 *   Chunks must be tokenized ({@link Reranker.tokenizeChunks}) before the
 *   call — the budget is measured in reranker tokens.
 * - `threshold` — score floor with a `topRejected` fallback (corpus style:
 *   the model's yes/no judgement gates admission; when nothing passes, the
 *   best rejects are surfaced so the agent sees "best I could find, but I
 *   don't stand behind any of them" instead of silence).
 *
 * @category Agents
 */
export type AdmitSelect =
  | { mode: 'budget'; topK: number; tokenBudget: number }
  | { mode: 'threshold'; threshold: number };

/** Options for {@link admitChunks}. @category Agents */
export interface AdmitOpts {
  /** Tool name recorded on every trace event this call writes. */
  tool: string;
  /** Resource label for the trace (e.g. the fetched URL). */
  url?: string;
  /** Which admission discipline gates the scored chunks. */
  select: AdmitSelect;
  /** Include per-chunk metadata in `rerank:start` (page tools do — replay
   *  sufficiency for freshly-fetched content; corpus chunks are already on
   *  disk, so it skips this). */
  traceChunkList?: boolean;
}

/** A budget-mode admitted passage — verbatim text plus its cost. @category Agents */
export interface AdmittedPassage {
  text: string;
  heading: string;
  score: number;
  tokenCount: number;
}

/** Result of {@link admitChunks}. Fields beyond the common trio are
 *  populated per selection mode. @category Agents */
export interface AdmitResult {
  /** Every scored chunk in FINAL order (post exploit re-rank when it ran). */
  scored: ScoredChunk[];
  /** Candidates actually cross-encoded (the reranker's `total`). */
  totalScored: number;
  /** Sum of admitted passage tokens (budget mode; 0 for threshold mode). */
  admittedTokens: number;
  /** budget mode: the selected passages, in order, budget-truncated. */
  passages?: AdmittedPassage[];
  /** budget mode: headings that scored but didn't make the cut (deduped) —
   *  the discovery signal the caller offers the agent as topics. */
  alsoOnPage?: string[];
  /** threshold mode: chunks at or above the floor, in final order. */
  admitted?: ScoredChunk[];
  /** threshold mode: top 3 rejects when NOTHING passed the floor. */
  topRejected?: ScoredChunk[];
}

/** Select top-K scored chunks within a token budget. The first chunk is
 *  truncated on a paragraph boundary when it alone exceeds the budget, so
 *  the agent always receives at least one passage. */
function selectTopChunks(
  scored: ScoredChunk[],
  chunks: Chunk[],
  topK: number,
  tokenBudget: number,
): AdmittedPassage[] {
  const selected: AdmittedPassage[] = [];
  let tokenTotal = 0;

  for (const sc of scored.slice(0, topK)) {
    const chunk = chunks.find(
      (c) => c.resource === sc.file && c.startLine === sc.startLine,
    );
    if (!chunk?.text) continue;

    const chunkTokens = chunk.tokens.length || Math.ceil(chunk.text.length / 4);

    if (tokenTotal + chunkTokens > tokenBudget) {
      if (selected.length === 0) {
        // Slice by THIS chunk's measured token density, not a fixed 4
        // chars/token — token-dense text (CJK, code) would otherwise blow
        // past the budget while the trace under-reports it. The marker is
        // reserved inside the budget, and the reported count is measured
        // back through the same density.
        const marker = '\n\n[truncated]';
        const density = chunkTokens / chunk.text.length;
        const charLimit = Math.max(1, Math.floor(tokenBudget / density) - marker.length);
        let truncated = chunk.text.slice(0, charLimit);
        const lastBreak = Math.max(
          truncated.lastIndexOf('\n\n'),
          truncated.lastIndexOf('. '),
        );
        if (lastBreak > charLimit * 0.4)
          truncated = truncated.slice(0, lastBreak + 1);
        selected.push({
          text: truncated + marker,
          heading: sc.heading,
          score: sc.score,
          tokenCount: Math.ceil((truncated.length + marker.length) * density),
        });
      }
      break;
    }

    selected.push({ text: chunk.text, heading: sc.heading, score: sc.score, tokenCount: chunkTokens });
    tokenTotal += chunkTokens;
  }

  return selected;
}

/**
 * The platform's retrieval-admission pipeline, extracted to ONE audited copy:
 * cross-encoder scoring (with progress), explore/exploit dual scoring, the
 * selection gate, and the trace events that make all of it observable —
 * `rerank:start`, `entailment:content:exploit` when exploit re-ranks, and
 * `rerank:end` carrying the full funnel (`topK`/`tokenBudget`/`threshold`,
 * `admittedTokens`, `totalScored`).
 *
 * **Explore mode** (default): agent-local scoring only. The agent chose this
 * resource — content is scored against what it asked for. Filtering against
 * the original query would remove bridging content and produce hypothesis
 * greps; discovery signals (`alsoOnPage`) compensate.
 *
 * **Exploit mode** (`context.explore === false`, set by
 * `policy.shouldExplore`): every chunk is re-scored by the entailment scorer
 * against the query and re-sorted — `min(toolQueryScore, originalQueryScore)`
 * tightens focus when KV or time is short, at the cost of serendipity.
 *
 * Callers own everything around it: fetching/chunking (and
 * `tokenizeChunks` for budget mode), any first-stage narrowing (BM25),
 * and how the result renders to the model. A source ability that uses this
 * helper gets the dev pane's admission view as a byproduct — the events it
 * writes ARE the pane's vocabulary.
 *
 * @category Agents
 */
export function* admitChunks(
  reranker: Reranker,
  chunks: Chunk[],
  query: string,
  context: ToolContext | undefined,
  opts: AdmitOpts,
): Operation<AdmitResult> {
  const tw = yield* Trace.expect();
  const t0 = performance.now();
  tw.write({
    traceId: tw.nextId(), parentTraceId: null, ts: t0,
    type: 'rerank:start', query, chunkCount: chunks.length,
    tool: opts.tool,
    ...(opts.url ? { url: opts.url } : {}),
    ...(opts.traceChunkList
      ? { chunks: chunks.map((c) => ({ heading: c.heading, textLength: c.text.length, startLine: c.startLine })) }
      : {}),
  });

  // ── Score against the agent's own query ─────────────────────
  let totalScored = 0;
  let scored: ScoredChunk[] = yield* call(async () => {
    let last: ScoredChunk[] = [];
    for await (const batch of reranker.score(query, chunks)) {
      if (context?.onProgress) context.onProgress({ filled: batch.filled, total: batch.total });
      last = batch.results;
      totalScored = batch.total;
    }
    return last;
  });

  // ── Exploit: dual scoring against the original query ────────
  if (!context?.explore && context?.scorer && scored.length > 0) {
    type ScoredWithOriginal = ScoredChunk & { _toolQueryScore: number };
    const chunkTexts = scored.map((sc) => {
      const chunk = chunks.find(
        (c) => c.resource === sc.file && c.startLine === sc.startLine,
      );
      return chunk?.text ?? '';
    });
    const combinedScores: number[] = yield* call(() =>
      context.scorer!.scoreRelevanceBatch(chunkTexts, query),
    );
    const reordered: ScoredWithOriginal[] = scored
      .map((sc, i) => ({ ...sc, score: combinedScores[i], _toolQueryScore: sc.score }))
      .sort((a, b) => b.score - a.score);
    scored = reordered;

    tw.write({
      traceId: tw.nextId(), parentTraceId: null, ts: performance.now(),
      type: 'entailment:content:exploit', tool: opts.tool,
      // Only the pressure the tool can SEE — absent values are omitted,
      // never written as sentinels.
      pressure:
        context.pressurePercentAvailable != null
          ? { percentAvailable: context.pressurePercentAvailable }
          : {},
      chunks: reordered.slice(0, 5).map((sc) => ({
        heading: sc.heading,
        toolQueryScore: sc._toolQueryScore,
        combinedScore: sc.score,
      })),
    });
  }

  // ── Selection gate ──────────────────────────────────────────
  const sel = opts.select;
  let result: AdmitResult;
  if (sel.mode === 'budget') {
    const passages = selectTopChunks(scored, chunks, sel.topK, sel.tokenBudget);
    const selectedHeadings = new Set(passages.map((p) => p.heading));
    const alsoOnPage = scored
      .filter((sc) => !selectedHeadings.has(sc.heading))
      .map((sc) => sc.heading)
      .filter((h, i, arr) => arr.indexOf(h) === i);
    const admittedTokens = passages.reduce((s, p) => s + p.tokenCount, 0);
    result = { scored, totalScored, admittedTokens, passages, alsoOnPage };
    tw.write({
      traceId: tw.nextId(), parentTraceId: null, ts: performance.now(),
      type: 'rerank:end',
      topResults: passages.map((p) => ({
        file: opts.url ?? opts.tool, heading: p.heading, score: p.score,
        textPreview: p.text.slice(0, 200),
      })),
      selectedPassageCount: passages.length,
      totalChars: passages.reduce((s, p) => s + p.text.length, 0),
      durationMs: performance.now() - t0,
      tool: opts.tool,
      ...(opts.url ? { url: opts.url } : {}),
      topK: sel.topK, tokenBudget: sel.tokenBudget,
      admittedTokens,
      totalScored,
    });
  } else {
    const admitted = scored.filter((r) => r.score >= sel.threshold);
    const topRejected = admitted.length === 0 ? scored.slice(0, 3) : [];
    result = { scored, totalScored, admittedTokens: 0, admitted, topRejected };
    tw.write({
      traceId: tw.nextId(), parentTraceId: null, ts: performance.now(),
      type: 'rerank:end',
      topResults: admitted.slice(0, 5).map((r) => ({ file: r.file, heading: r.heading, score: r.score })),
      selectedPassageCount: admitted.length,
      totalChars: 0,
      durationMs: performance.now() - t0,
      tool: opts.tool,
      threshold: sel.threshold,
      totalScored,
    });
  }
  return result;
}
