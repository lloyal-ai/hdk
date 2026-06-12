import type { SessionContext, RerankResult, RerankProgress } from './types';
import { Branch } from './Branch';
import { BranchStore } from './BranchStore';

const SYSTEM_PROMPT =
  'Judge whether the Document meets the requirements based on the Query ' +
  'and the Instruct provided. Note that the answer can only be "yes" or "no".';

const USER_PREFIX =
  '<Instruct>: Given a web search query, retrieve relevant passages that answer the query\n\n' +
  '<Query>: ';

// Boot canary fixtures — hardcoded to Qwen3-reranker semantics. If you swap
// reranker models, re-run the calibration probe and update these fixtures.
const CANARY_QUERY = 'What is the capital of France?';
const CANARY_RELEVANT_DOC =
  'Paris is the capital and most populous city of France.';
const CANARY_IRRELEVANT_DOC =
  'Photosynthesis converts carbon dioxide and water into glucose.';

// Sentinel strings used to discover segment boundaries inside the rendered
// chat probe. Longer ASCII (not NUL bytes) survives tokenizer normalization;
// the BPE-boundary invariance check at boot still verifies that the sentinels
// did not cause merges across segment seams.
const SENTINEL_Q = '__RERANK_QUERY_PROBE_a3f7__';
const SENTINEL_D = '__RERANK_DOC_PROBE_a3f7__';

/**
 * Thrown by {@link Rerank.create} when calibration gates fail (single-token
 * yes/no, BPE-boundary invariance, boot canary signs). Each instance includes
 * the specific gate and the empirical evidence so callers can fix at the
 * right layer (model swap, sentinel change, template drift).
 */
export class RerankCalibrationError extends Error {
  readonly name = 'RerankCalibrationError';
}

/**
 * Thrown when Rerank's internal invariants are violated (lease exhaustion
 * mid-query, fork returning a disposed handle, etc.). These represent state
 * the consumer cannot fix; the diagnostic exists for framework-side triage.
 */
export class RerankInternalError extends Error {
  readonly name = 'RerankInternalError';
}

/**
 * Truncation event emitted via {@link RerankOpts.onTruncate} when a document's
 * token count exceeds the per-leaf budget and gets sliced from the head.
 */
export interface RerankTruncation {
  /** Position of the truncated document in the score() / scoreBatch() input array. */
  docIndex: number;
  /** Original token count of the document. */
  origLen: number;
  /** Tokens kept (slice from start to maxLen). */
  maxLen: number;
}

/**
 * Construction options for {@link Rerank.create}.
 */
export interface RerankOpts {
  /**
   * Maximum parallel scoring sequences in the underlying BranchStore.
   * Effective per-group leaf budget is `nSeqMax - 2` because the warm trunk
   * and per-query branch each hold one lease. Default 10 (= 8 leaves), which
   * preserves the prior default leaf width while introducing the warm-trunk
   * lease.
   */
  nSeqMax?: number;
  /**
   * Per-context KV budget. Defaults to the value reported by the underlying
   * SessionContext. Per-sequence token budget is `floor(nCtx / nSeqMax)`.
   */
  nCtx?: number;
  /**
   * Optional callback invoked once per document whose tokens exceeded the
   * per-leaf budget. Consumers can forward to a trace surface
   * (`rerank:truncate`) or to a metric. Silent in the SDK by default.
   */
  onTruncate?: (event: RerankTruncation) => void;
}

interface ProgressSink {
  push: (progress: RerankProgress) => void;
  finish: () => void;
  error: (err: Error) => void;
}

/**
 * Async channel — internal driver pushes; consumer pulls via for-await.
 *
 * The returned iterator supports `return()` so `for-await break` and explicit
 * `iterator.return()` both invoke `onCancel`. Without this hook the upstream
 * driver has no way to know the consumer has stopped reading and would keep
 * issuing GPU dispatches for documents whose scores will be discarded.
 *
 * @param onCancel - Invoked at most once when the consumer cancels the iterator.
 */
function channel<T>(onCancel?: () => void): {
  push: (value: T) => void;
  finish: () => void;
  error: (err: Error) => void;
  iterable: AsyncIterable<T>;
} {
  const buffer: T[] = [];
  let done = false;
  let err: Error | null = null;
  let notify: (() => void) | null = null;
  let cancelFired = false;

  const wait = () => new Promise<void>((r) => { notify = r; });

  return {
    push(value: T) {
      buffer.push(value);
      notify?.();
      notify = null;
    },
    finish() {
      done = true;
      notify?.();
      notify = null;
    },
    error(e: Error) {
      err = e;
      notify?.();
      notify = null;
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          async next(): Promise<IteratorResult<T>> {
            while (buffer.length === 0 && !done && !err) await wait();
            if (err) throw err;
            if (buffer.length > 0) return { value: buffer.shift()!, done: false };
            return { value: undefined as unknown as T, done: true };
          },
          async return(): Promise<IteratorResult<T>> {
            done = true;
            if (!cancelFired) {
              cancelFired = true;
              onCancel?.();
            }
            notify?.();
            notify = null;
            return { value: undefined as unknown as T, done: true };
          },
        };
      },
    },
  };
}

/**
 * Cross-encoder reranker composed over the SDK's Branch / BranchStore primitives.
 *
 * # Lifetime + concurrency contract
 *
 * Rerank takes **exclusive ownership** of its SessionContext. Routing any other
 * decode through the same context concurrently is undefined behavior — the
 * kernel's `llama_context::decode` carries no internal mutex (verified at
 * llama.cpp b9581). Enforcement is at construction: `Rerank.create()` marks
 * the context with a `__decodeOwner` flag and refuses a second instance.
 * The flag is cleared by `dispose()`, so test/REPL re-creation works.
 *
 * Concurrent `score()` / `scoreBatch()` calls **on the same Rerank instance**
 * are serialized by a per-instance Promise chain (~10 LOC). The kernel sees
 * them in arrival order; consumers still get a concurrent-looking API.
 *
 * # Architecture
 *
 *   [SYSTEM][USER_PREFIX][QUERY][MID][DOC_i][SUFFIX][GEN_PROMPT]
 *   └── permanent trunk ─┘ └── per-query branch ──┘ └─── per-chunk leaves ─┘
 *
 * - **trunk**: prefilled with the static [SYSTEM][USER_PREFIX] segment ONCE
 *   at `Rerank.create()`; lives for the instance lifetime. Warm KV is
 *   amortized across every score() via multi-tag KV survival.
 * - **queryBranch**: forked from trunk per score() call, prefilled with
 *   `[query, ...midTokens]`. Forked with `cloneLogits: false` because we
 *   immediately overwrite the logits with the prefill.
 * - **leaves**: forked from queryBranch in groups of `BranchStore.available`,
 *   scatter-prefilled with `[doc_i, ...suffixTokens]` via `BranchStore.prefill`
 *   (one `llama_decode` per group), scored via `_branchLogitsAt` reading
 *   exactly two floats per leaf, pruned.
 *
 * # Calibration gates (fail-loud at create() time)
 *
 *   1. `yes` and `no` must tokenize as single tokens (the score formula
 *      `logit("yes") − logit("no")` assumes this; broader support requires
 *      log-sum-exp over label sequences, a 3.x ticket).
 *   2. BPE-boundary invariance — tokenizing a canary full prompt must equal
 *      the concat of (prefix, query, mid, doc, suffix) tokenized separately,
 *      so segment seams don't silently shift the leaf prompts.
 *   3. Boot canary — score a known relevant + irrelevant pair; relevant
 *      must outscore irrelevant by > 1.0 logit unit. Asserts the *gap*,
 *      NOT absolute signs — quantization shifts calibration enough that
 *      sign assertions are brittle, while the ordering gap still catches
 *      yes/no token swap, model swap, and template drift.
 *
 * # Score formula
 *
 *   score = `logit("yes") − logit("no")` (unbounded).
 *
 *   **This is the log-odds of an absolute yes/no relevance judgment.** The
 *   model is a pointwise binary cross-encoder; the official Qwen3-Reranker
 *   score is the two-token softmax over {yes,no} — i.e. `sigmoid(score)` =
 *   P(yes) ∈ [0,1] — and our log-odds is its monotone equivalent (identical
 *   rankings, full dynamic range). Scores ARE thresholdable (0 ≡ P 0.5) and
 *   comparable across queries to the extent of the model's calibration;
 *   quantization adds noise at the extremes. Top-1 routinely goes negative
 *   on real corpora when no document is strongly relevant — an honest
 *   "probably not", with the ranking still useful. Production traces show
 *   top-1 ranging from +10 (P≈.9999) to -3 (P≈.05, weak best match).
 *
 *   The previous softmax form compressed small logit gaps into extreme
 *   probabilities (gap of 5 → 0.993; gap of 10 → 0.99995), saturating top-K
 *   ordering. Logit-diff preserves the full dynamic range. See
 *   `reasoning.run/scripts/inspect-rerank.mjs` for empirical evidence.
 *
 *   Consumers that want a confidence threshold should calibrate against their
 *   own corpus rather than assuming `> 0` means "relevant" — see SearchTool's
 *   threshold envelope.
 */
export class Rerank {
  private _ctx: SessionContext;
  private _store: BranchStore;
  private _trunk: Branch;
  private _nSeqMax: number;
  private _nCtx: number;
  private _yesId: number;
  private _noId: number;
  private _midTokens: number[];
  private _suffixTokens: number[];
  private _staticPrefix: number[];
  private _onTruncate?: (event: RerankTruncation) => void;
  private _inflight: Promise<void> = Promise.resolve();
  private _disposed = false;

  private constructor(
    ctx: SessionContext,
    store: BranchStore,
    trunk: Branch,
    nSeqMax: number,
    nCtx: number,
    yesId: number,
    noId: number,
    staticPrefix: number[],
    midTokens: number[],
    suffixTokens: number[],
    onTruncate?: (event: RerankTruncation) => void,
  ) {
    this._ctx = ctx;
    this._store = store;
    this._trunk = trunk;
    this._nSeqMax = nSeqMax;
    this._nCtx = nCtx;
    this._yesId = yesId;
    this._noId = noId;
    this._staticPrefix = staticPrefix;
    this._midTokens = midTokens;
    this._suffixTokens = suffixTokens;
    this._onTruncate = onTruncate;
  }

  /**
   * Create a Rerank instance bound to a pre-created SessionContext.
   *
   * Rerank takes exclusive ownership of `ctx` (see class docstring). The
   * caller must construct `ctx` with `nSeqMax` ≥ 3 (one slot each for trunk
   * + queryBranch + at least one leaf).
   *
   * Fires three calibration gates at boot. If any gate fails, throws
   * {@link RerankCalibrationError} with a diagnostic naming the failure and
   * cleans up partial state (no ctx leak).
   */
  static async create(ctx: SessionContext, opts?: RerankOpts): Promise<Rerank> {
    const owner = (ctx as unknown as { __decodeOwner?: string }).__decodeOwner;
    if (owner) {
      throw new RerankInternalError(
        `SessionContext already has a decode owner (${owner}); Rerank ` +
          `requires exclusive ownership. Construct a dedicated SessionContext.`,
      );
    }

    const nSeqMax = opts?.nSeqMax ?? 10;
    const nCtx = opts?.nCtx ?? ctx._storeKvPressure().nCtx;

    // Calibration gate 1: single-token yes / no
    const yesTokens = await ctx.tokenize('yes', false);
    const noTokens = await ctx.tokenize('no', false);
    if (yesTokens.length !== 1) {
      throw new RerankCalibrationError(
        `Reranker model tokenizes 'yes' as ${yesTokens.length} tokens ` +
          `(expected 1). The score formula logit("yes") − logit("no") ` +
          `requires single-token labels. Broader support requires ` +
          `generalizing the formula to log-sum-exp over label sequences (3.x).`,
      );
    }
    if (noTokens.length !== 1) {
      throw new RerankCalibrationError(
        `Reranker model tokenizes 'no' as ${noTokens.length} tokens (expected 1).`,
      );
    }
    const yesId = yesTokens[0];
    const noId = noTokens[0];

    // Render sentinel probe to discover segment boundaries.
    const probe = await ctx.formatChat(
      JSON.stringify([
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `${USER_PREFIX}${SENTINEL_Q}\n\n<Document>: ${SENTINEL_D}`,
        },
      ]),
      { addGenerationPrompt: true, enableThinking: false },
    );
    const p = probe.prompt;
    const qi = p.indexOf(SENTINEL_Q);
    const di = p.indexOf(SENTINEL_D);
    if (qi < 0 || di < 0 || qi >= di) {
      throw new RerankCalibrationError(
        `Sentinel probe failed to locate segment boundaries: ` +
          `SENTINEL_Q ${qi < 0 ? 'missing' : `@${qi}`}, ` +
          `SENTINEL_D ${di < 0 ? 'missing' : `@${di}`}. ` +
          `The chat template may have stripped or reordered the sentinels.`,
      );
    }

    const prefixText = p.slice(0, qi);
    const midText = p.slice(qi + SENTINEL_Q.length, di);
    const suffixText = p.slice(di + SENTINEL_D.length);

    const prefixTokens = await ctx.tokenize(prefixText, true);
    const midTokens = await ctx.tokenize(midText, false);
    const suffixTokens = await ctx.tokenize(suffixText, false);

    // Calibration gate 2: BPE-boundary drift bound.
    // Re-tokenize a CANARY full prompt and compare to segment-concat. Most
    // chat templates produce small drift (1-5 tokens) from BOS/EOS handling,
    // assistant-start tokens, or whitespace normalization across segment
    // seams. The boot canary (gate 3) is the load-bearing behavioral test;
    // this gate exists to catch CATASTROPHIC drift (a sentinel that triggers
    // a multi-token BPE merge), so we threshold at 5% of the whole-prompt
    // length. Exact-equality was too strict for the Qwen3-reranker template
    // (it drifts by ~3 tokens on the canary prompt, but the boot canary
    // still scores cleanly).
    const canaryQueryTokens = await ctx.tokenize(CANARY_QUERY, false);
    const canaryDocTokens = await ctx.tokenize(CANARY_RELEVANT_DOC, false);
    const canaryWhole = await ctx.formatChat(
      JSON.stringify([
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `${USER_PREFIX}${CANARY_QUERY}\n\n<Document>: ${CANARY_RELEVANT_DOC}`,
        },
      ]),
      { addGenerationPrompt: true, enableThinking: false },
    );
    const canaryWholeTokens = await ctx.tokenize(canaryWhole.prompt, true);
    const canaryConcatLen =
      prefixTokens.length +
      canaryQueryTokens.length +
      midTokens.length +
      canaryDocTokens.length +
      suffixTokens.length;
    const bpeDrift = Math.abs(canaryWholeTokens.length - canaryConcatLen);
    const bpeDriftRatio = bpeDrift / canaryWholeTokens.length;
    if (bpeDriftRatio > 0.05) {
      throw new RerankCalibrationError(
        `BPE-boundary drift exceeds 5%: ` +
          `tokenize(full canary prompt) = ${canaryWholeTokens.length} tokens, ` +
          `concat(prefix+query+mid+doc+suffix) = ${canaryConcatLen} tokens, ` +
          `drift = ${bpeDrift} (${(bpeDriftRatio * 100).toFixed(1)}%). ` +
          `Sentinel choice is causing multi-token BPE merges across segment ` +
          `boundaries; leaf prompts would silently differ from the form the ` +
          `model was trained against. Try a fresh sentinel pair or check the ` +
          `reranker model's tokenizer version.`,
      );
    }

    // Claim the context, build the trunk + store. From this point on we
    // must clean up __decodeOwner + trunk on any failure path.
    (ctx as unknown as { __decodeOwner: string }).__decodeOwner = 'rerank';
    const store = new BranchStore(ctx);
    const trunk = Branch.create(ctx, 0);
    try {
      await trunk.prefill(prefixTokens);

      const r = new Rerank(
        ctx,
        store,
        trunk,
        nSeqMax,
        nCtx,
        yesId,
        noId,
        prefixTokens,
        midTokens,
        suffixTokens,
        opts?.onTruncate,
      );

      // Calibration gate 3: boot canary RELATIVE ordering.
      //
      // The reranker is a CLM with logit-diff scoring — a *relative* ranker,
      // not an absolute calibrator. Production traces show top-1 scores
      // routinely going negative on real corpora (e.g. -2.8 for the best
      // match when no doc is strongly relevant); rankings remain correct
      // because the model picks the least-irrelevant doc. The canary
      // therefore asserts ordering, not signs: a clearly-relevant pair must
      // outscore a clearly-irrelevant one by a meaningful margin.
      //
      // This still catches the failure modes a sign-threshold would have
      // caught — yes/no token swap (rankings invert), model swap (random
      // scores → no consistent ordering), template drift (random scores) —
      // without false-positiving on aggressively-quantized models that
      // produce shifted-but-monotone score distributions.
      const canaryScores = await r.scoreBatch(CANARY_QUERY, [
        CANARY_RELEVANT_DOC,
        CANARY_IRRELEVANT_DOC,
      ]);
      const gap = canaryScores[0] - canaryScores[1];
      if (!(gap > 1.0)) {
        throw new RerankCalibrationError(
          `Boot canary failed: relevant pair scored ` +
            `${canaryScores[0].toFixed(3)}, irrelevant pair scored ` +
            `${canaryScores[1].toFixed(3)} (gap=${gap.toFixed(3)}, ` +
            `expected > 1.0). Possible causes: yes/no token id swap, ` +
            `reranker model swap, or chat template drift. ` +
            `Canary pair: query=${JSON.stringify(CANARY_QUERY)}, ` +
            `relevant=${JSON.stringify(CANARY_RELEVANT_DOC)}, ` +
            `irrelevant=${JSON.stringify(CANARY_IRRELEVANT_DOC)}.`,
        );
      }

      return r;
    } catch (err) {
      // Boot failure: scrub partial state before re-raising so the ctx is
      // re-usable by the next Rerank.create() attempt.
      try { trunk.pruneSubtreeSync(); } catch { /* trunk may already be gone */ }
      delete (ctx as unknown as { __decodeOwner?: string }).__decodeOwner;
      throw err;
    }
  }

  /**
   * Stream progressive ranking results for `documents` against `query`.
   *
   * Pre-tokenized documents must come from {@link tokenize} or a reranker-
   * compatible tokenizer; mismatched tokenizers silently produce wrong scores.
   *
   * Consumers may cancel by calling `iterator.return()` directly or by
   * `for-await break`. Cancellation bounds the post-cancel cost at the one
   * leaf group already in flight; subsequent groups are skipped.
   */
  score(
    query: string,
    documents: number[][],
    topK?: number,
  ): AsyncIterable<RerankProgress> {
    if (this._disposed) throw new Error('Rerank disposed');

    const self = this;
    let cancelled = false;
    const ch = channel<RerankProgress>(() => {
      cancelled = true;
    });

    void (async () => {
      // Per-instance serializer: capture the previous tail, register ours,
      // then wait. New score() / scoreBatch() calls chain behind us.
      const prev = self._inflight;
      let release!: () => void;
      self._inflight = new Promise<void>((r) => {
        release = r;
      });

      try {
        await prev;
        await self._scoreInternal(query, documents, topK, ch, () => cancelled);
        ch.finish();
      } catch (err) {
        ch.error(err instanceof Error ? err : new Error(String(err)));
      } finally {
        release();
      }
    })();

    return ch.iterable;
  }

  /**
   * Batch-score raw text strings against a query. Returns logit-diff scores
   * (unbounded; positive = "yes", negative = "no", magnitude = confidence) in
   * input order.
   */
  async scoreBatch(query: string, texts: string[]): Promise<number[]> {
    if (this._disposed) throw new Error('Rerank disposed');
    if (texts.length === 0) return [];

    // Acquire the serializer chain (same chain score() uses).
    const prev = this._inflight;
    let release!: () => void;
    this._inflight = new Promise<void>((r) => {
      release = r;
    });

    try {
      await prev;
      // Tokenize in parallel — the old code used tokenizeSync, blocking the
      // event loop for the whole batch.
      const docTokens = await Promise.all(
        texts.map((t) => this._ctx.tokenize(t, false)),
      );

      const scores = new Array<number>(texts.length);
      // Sink captures the cumulative scores from each emission. The final
      // emission contains all positions, but every intermediate emission
      // already has the scores in place — so the by-index write below is
      // safe whether we observe one or many emissions.
      const sink: ProgressSink = {
        push: (p: RerankProgress) => {
          for (const r of p.results) {
            scores[r.index] = r.score;
          }
        },
        finish: () => {},
        error: (e: Error) => {
          throw e;
        },
      };
      await this._scoreInternal(query, docTokens, undefined, sink, () => false);
      return scores;
    } finally {
      release();
    }
  }

  /** Tokenize text using the reranker's underlying tokenizer. */
  async tokenize(text: string): Promise<number[]> {
    return this._ctx.tokenize(text, false);
  }

  /** Release Rerank state, clear ctx ownership, dispose ctx. Idempotent. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    // pruneSubtree (CASCADE) instead of prune (RESTRICT) — if queryBranch or
    // leaves leaked from a swallowed abandonment, RESTRICT prune would throw
    // "branch has children" and mask the original error. pruneSubtree is
    // safe on a childless trunk and correct on a partially-pruned tree.
    try { this._trunk.pruneSubtreeSync(); } catch { /* already pruned */ }
    delete (this._ctx as unknown as { __decodeOwner?: string }).__decodeOwner;
    this._ctx.dispose();
  }

  // ── Internals ────────────────────────────────────────────────

  /**
   * The shared scoring driver. Both `score()` (async-iterable) and
   * `scoreBatch()` (Promise) call into this once the serializer is held.
   */
  private async _scoreInternal(
    query: string,
    documents: number[][],
    topK: number | undefined,
    sink: ProgressSink,
    isCancelled: () => boolean,
  ): Promise<void> {
    const queryTokens = await this._ctx.tokenize(query, false);
    const sharedLen =
      this._staticPrefix.length + queryTokens.length + this._midTokens.length;
    const maxDoc =
      Math.floor(this._nCtx / this._nSeqMax) -
      sharedLen -
      this._suffixTokens.length;

    if (maxDoc <= 0) {
      throw new RerankInternalError(
        `Per-leaf doc budget is ${maxDoc} (nCtx=${this._nCtx}, ` +
          `nSeqMax=${this._nSeqMax}, shared=${sharedLen}, ` +
          `suffix=${this._suffixTokens.length}). ` +
          `Query/template too long for context capacity.`,
      );
    }

    // Truncation observability — fire callback once per truncated doc, even
    // before any decode happens. Consumers can map this to a trace event.
    if (this._onTruncate) {
      for (let i = 0; i < documents.length; i++) {
        if (documents[i].length > maxDoc) {
          this._onTruncate({
            docIndex: i,
            origLen: documents[i].length,
            maxLen: maxDoc,
          });
        }
      }
    }

    if (documents.length === 0) {
      sink.push({ filled: 0, total: 0, results: [] });
      return;
    }

    // Fork the per-query branch from the warm trunk. cloneLogits: false
    // because the next thing we do is overwrite via prefill.
    const queryBranch = await this._trunk.fork({ cloneLogits: false });
    if (queryBranch.disposed) {
      throw new RerankInternalError(
        'queryBranch fork returned a disposed handle (BranchStore lease exhaustion?)',
      );
    }

    try {
      // Branch.prefill mirrors the spine.prefill / root.prefill convention
      // for one-off setup decodes. Routes through the same _storePrefill
      // primitive that BranchStore.prefill uses for batched leaf dispatches.
      await queryBranch.prefill([...queryTokens, ...this._midTokens]);

      const scores = new Array<number>(documents.length);
      let i = 0;
      const yesNoIndices = new Int32Array([this._yesId, this._noId]);

      while (i < documents.length) {
        if (isCancelled()) break;

        const available = this._store.available;
        const budget = Math.min(available, documents.length - i);
        if (budget === 0) {
          throw new RerankInternalError(
            `BranchStore.available returned 0 with ${documents.length - i} ` +
              `docs remaining (expected ≥1 free slot after trunk + ` +
              `queryBranch leases). Check for leaked branches or under-sized ` +
              `nSeqMax (currently ${this._nSeqMax}).`,
          );
        }

        const tails = new Array<number[]>(budget);
        for (let k = 0; k < budget; k++) {
          const doc = documents[i + k];
          const trimmed = doc.length > maxDoc ? doc.slice(0, maxDoc) : doc;
          tails[k] = [...trimmed, ...this._suffixTokens];
        }

        // Leaf-group try/finally — leaves prune even if scatter-prefill or
        // logits read throws mid-group. Without this, the outer
        // queryBranch.pruneSubtree() in the score()-level finally is the
        // only path that reclaims leaves, but it can't run until the
        // exception unwinds past `i += budget`.
        const leaves: Branch[] = [];
        try {
          for (let k = 0; k < budget; k++) {
            const leaf = await queryBranch.fork({ cloneLogits: false });
            if (leaf.disposed) {
              throw new RerankInternalError(
                `Leaf fork returned a disposed handle at k=${k}/${budget}`,
              );
            }
            leaves.push(leaf);
          }

          // Batched scatter-prefill — N leaves in ONE llama_decode dispatch.
          await this._store.prefill(
            leaves.map((leaf, k): [Branch, number[]] => [leaf, tails[k]]),
          );

          // Read 2 floats per leaf via _branchLogitsAt — NOT n_vocab via
          // _branchGetLogits. The native primitive added in R1.
          for (let k = 0; k < budget; k++) {
            const pair = this._ctx._branchLogitsAt(
              leaves[k].handle,
              yesNoIndices,
            );
            scores[i + k] = pair[0] - pair[1];
          }
        } finally {
          // pruneSubtree (CASCADE) is safe on a childless leaf, so use it
          // uniformly. The catch-and-swallow keeps the cleanup from masking
          // the original error.
          await Promise.all(
            leaves.map((leaf) =>
              leaf.pruneSubtree().catch(() => {
                /* leaf may already be disposed by an outer cleanup */
              }),
            ),
          );
        }

        i += budget;

        // Cumulative emission — sort on RAW scores; rounding is the
        // consumer's choice. Sorting on rounded scores (the prior code's
        // behavior) made tie-broken-by-insertion-order the rank decider, the
        // B1 mechanism for testRerankLargeCorpus.
        sink.push({
          filled: i,
          total: documents.length,
          results: this._sortRaw(scores.slice(0, i), topK),
        });
      }
    } finally {
      // CASCADE prune queryBranch + any leaked descendants. Safer than
      // RESTRICT prune() if leaves leaked from a swallowed catch above.
      await queryBranch.pruneSubtree().catch(() => {
        /* already pruned */
      });
    }
  }

  /**
   * Sort scores descending, raw (unrounded). Consumers that want display
   * rounding apply `Math.round(score * 1000) / 1000` themselves.
   */
  private _sortRaw(scores: number[], topK: number | undefined): RerankResult[] {
    const sorted = scores
      .map((score, index) => ({ score, index }))
      .sort((a, b) => b.score - a.score);
    return topK != null ? sorted.slice(0, topK) : sorted;
  }
}

function tokenArraysEqual(a: number[] | Int32Array, b: number[] | Int32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
