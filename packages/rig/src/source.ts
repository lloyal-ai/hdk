import type { Tool, EntailmentScorer } from '@lloyal-labs/lloyal-agents';
import { NULL_SCORER } from '@lloyal-labs/lloyal-agents';
import type { Attachment } from '@lloyal-labs/media';
import type { Reranker } from './retrieval';

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
 * @category Rig
 */
export abstract class Source<TChunk = unknown> {
  /** Human-readable source name (e.g. 'web', 'corpus') for labeling output */
  abstract readonly name: string;
  /** Data access tools provided by this source */
  abstract get tools(): Tool[];

  /** Reranker instance, injected at construction by the ability factory. Used by {@link createScorer}. */
  protected _reranker: Reranker | null = null;
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
   * run.
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
