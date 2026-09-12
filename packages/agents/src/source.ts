import type { Tool } from './Tool';
import type { Attachment } from '@lloyal-labs/media';

/**
 * Entailment scorer — scores texts against an original query to
 * maintain semantic coherence across recursive agent pipelines.
 *
 * Created per invocation via {@link Source.createScorer}.
 * Immutable once created — safe to share across concurrent pools.
 *
 * ## Three queries in play
 *
 * | Concept            | Scope                    | Field name in code                        |
 * |--------------------|--------------------------|-------------------------------------------|
 * | **Tool query**     | Per tool call            | scored by the tool's own reranker pass |
 * | **Agent task**     | Per agent lifetime       | `reference` param of scoreSimilarityBatch |
 * | **Original query** | Per research invocation  | Captured in closure by createScorer       |
 *
 * - `scoreEntailmentBatch` scores against the **original query** (steering boundaries)
 * - exploit mode (`admitChunks`) takes `min(tool-query score, scoreEntailmentBatch)` — one extra pass, never two
 * - `scoreSimilarityBatch` scores against an arbitrary **reference** (echo detection uses agent task)
 *
 * **Unit.** Every score this interface returns is the reranker's LOGIT
 * difference: unbounded, centred on zero, positive meaning "yes". Not a 0–1
 * similarity; any threshold over these numbers is in logits.
 *
 * Conflating these produces wrong scores. When adding new scoring
 * methods or trace events, use the field names from this table.
 *
 * @category Agents
 */
export interface EntailmentScorer {
  /** Score texts against the original query. One score per text, in the
   *  scorer's unit (see the interface doc). */
  scoreEntailmentBatch(texts: string[]): Promise<number[]>;
  /** Score texts against an arbitrary reference string (echo detection uses
   *  the agent task). One score per text, in the scorer's unit. */
  scoreSimilarityBatch(reference: string, texts: string[]): Promise<number[]>;
  /** Threshold gate — returns true if the score is high enough to proceed. */
  shouldProceed(score: number): boolean;
}

/** No-op scorer — all scores 1.0, all proceed. Used when no reranker is available. */
export const NULL_SCORER: EntailmentScorer = {
  scoreEntailmentBatch: async (texts) => texts.map(() => 1),
  scoreSimilarityBatch: async (_ref, texts) => texts.map(() => 0),
  shouldProceed: () => true,
};

/**
 * Reranker interface required by {@link Source.createScorer}.
 *
 * Duplicated here to avoid a circular dependency between agents and rig.
 * Any object with a `scoreBatch` method satisfies this contract.
 */
export interface ScorerReranker {
  scoreBatch(query: string, texts: string[]): Promise<number[]>;
}

/**
 * Abstract base class for data sources.
 *
 * A source is a named collection of data access tools plus an entailment
 * scoring factory. Its reranker is injected at construction by the ability
 * factory (`_reranker`); there is no bind lifecycle. It does not orchestrate
 * agents — the harness does, through the pool.
 *
 * @typeParam TChunk - Chunk type returned by {@link getChunks} for post-use reranking
 *
 * @category Agents
 */
export abstract class Source<TChunk = unknown> {
  /** Human-readable source name (e.g. 'web', 'corpus') for labeling output */
  abstract readonly name: string;
  /** Data access tools provided by this source */
  abstract get tools(): Tool[];

  /** Reranker instance, injected at construction by the ability factory. Used by {@link createScorer}. */
  protected _reranker: ScorerReranker | null = null;
  /**
   * Minimum entailment score for delegation to proceed.
   *
   * Reranker scores are logit-diffs (`logit(yes) − logit(no)`); a value
   * `> 0` means the cross-encoder model prefers "yes" over "no" when
   * asked whether the document matches the query. Default `0` ⇒ "the
   * model agrees this passage is relevant"; subclasses may tighten
   * (e.g. `2` for "confident yes") or loosen (negative, for noisy
   * corpora where leaning-no hits are still worth investigating).
   *
   * The prior softmax-prob default was `0.25`, which corresponded to
   * logit-diff `≈ −1.1`. The new default is stricter: only hits the
   * model genuinely leans toward are surfaced. See TICK-002 calibration
   * notes (`reasoning.run/scripts/inspect-rerank.mjs`) for the data.
   */
  protected _entailmentFloor: number = 0;

  /**
   * Create an immutable entailment scorer scoped to one invocation.
   *
   * The returned scorer captures `originalQuery` in a closure — no mutable
   * state on Source. Safe to use across concurrent pools within the same
   * research run.
   *
   * @param originalQuery - The root query from the harness
   */
  createScorer(originalQuery: string): EntailmentScorer {
    const reranker = this._reranker;
    if (!reranker || !originalQuery) return NULL_SCORER;

    const floor = this._entailmentFloor;

    return {
      async scoreEntailmentBatch(texts: string[]): Promise<number[]> {
        return reranker.scoreBatch(originalQuery, texts);
      },
      async scoreSimilarityBatch(reference: string, texts: string[]): Promise<number[]> {
        return reranker.scoreBatch(reference, texts);
      },
      shouldProceed(score: number): boolean {
        return score >= floor;
      },
    };
  }

  /** Post-use chunks for reranking. Called after agents have used the tools. */
  getChunks(): TChunk[] { return []; }

  /**
   * Ability-level prompt data (e.g. a corpus TOC) for the HARNESS to place.
   *
   * Identical for every agent in a pool, so it belongs in shared KV —
   * rendered ONCE, not duplicated per spawn (six 4.8k-token TOC-bearing
   * suffixes overran a 32k context before this contract existed).
   *
   * Placement is a TRUST decision, which is why the framework does not
   * place it automatically: this is free prose derived from source
   * content, and the shared spine prefix is read by every agent in the
   * pool. A harness may append it to its spine prompt for abilities it trusts
   * (first-party corpora); it must not blanket-append data from untrusted
   * third-party abilities — `renderSpine` itself stays prose-free for exactly
   * this reason.
   *
   * `attachments` are the assets available to the run being staged — roots,
   * as the host holds them. A source keyed on attachments builds its data
   * from them; a source that is not ignores the argument.
   */
  promptData(_attachments: readonly Attachment[] = []): Record<string, unknown> { return {}; }
}
