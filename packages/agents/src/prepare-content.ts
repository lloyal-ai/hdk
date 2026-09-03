/**
 * @file The media barrier: admit a whole batch, or admit none of it.
 *
 * The Operation layer built ON the content ports, kept out of them for the
 * reason `trace-scope.ts` is kept out of `trace-writer.ts` — the ports are the
 * contract, this is the pipeline that drives them. It stays here because a
 * batch is cancelled by the SCOPE that owns it, and scopes are orchestration.
 */
import { all, call, useAbortSignal } from 'effection';
import type { Operation } from 'effection';
import type {
  Attachment, AttachmentStore, ContentIngress, PreparedContent,
} from '@lloyal-labs/media';
import { materialize } from '@lloyal-labs/media';

/**
 * Admit a whole batch of raw media, or admit none of it.
 *
 * The barrier this enforces, in order:
 *
 * 1. **Prepare** every item, committing each root manifest.
 * 2. **Materialize** every representation.
 * 3. **Flatten** preserving attachment order, then representation order within
 *    each — markers correspond to REPRESENTATIONS, so a video contributes its
 *    frames here and an image contributes one.
 * 4. Only then may a caller emit markers, build a delta, and prefill.
 *
 * A failure on item N leaves the content of items 1…N−1 in the store,
 * unreachable by anything. That is harmless — content-addressed, unreferenced,
 * the same orphan class the write-order invariant already accepts. What it
 * must NOT leave is a half-admitted query: zero prefills, zero markers, zero
 * published descriptors, unchanged KV.
 *
 * Concurrent, in input order: the ingests overlap (`all`), because
 * normalization is the expensive step and the normalizer already bounds
 * itself process-wide — a batch of N must not cost the sum of N decodes while
 * permits sit idle — and `all` returns results in the order given, so order
 * stays part of the contract. An Operation rather than an async function, so
 * a halted scope cancels the whole batch instead of leaving it running
 * detached — the promise boundary into the ingress is crossed with `call()`,
 * and the scope's signal reaches the ingress itself.
 *
 * **Scope this claim carefully.** This makes media *preparation* atomic with
 * respect to the prefill. It does NOT make the prefill itself transactional —
 * `decode_segments` is not atomic, so a failure DURING a prefill still
 * poisons its branch and is handled by the prune-and-replay contract, not by
 * this barrier.
 *
 * @throws Whatever ingest or materialization threw, unchanged — the caller
 *         needs the real reason, and must not proceed to prefill.
 *
 * @category Agents
 */
export function* prepareBatch(
  ingress: ContentIngress,
  store: AttachmentStore,
  items: readonly Uint8Array[],
): Operation<PreparedContent> {
  // The scope's own signal, hoisted once. `call()` makes a halt OBSERVABLE at
  // this boundary but cannot stop the promise behind it — that is the leaked
  // effect Effection's own docs warn about — so the signal is what actually
  // reaches the ingress. A halted run stops occupying the normalizer's queue
  // instead of holding a slot for work whose result nobody will read.
  const signal = yield* useAbortSignal();
  // Concurrent, in input order: normalization is the expensive step and the
  // normalizer already bounds itself process-wide, so a batch of N must not
  // cost the sum of N decodes while permits sit idle. `all` keeps the order.
  const roots: Attachment[] = yield* all(items.map((bytes) => call(() => ingress.ingest(bytes, signal))));
  // Resolve from the store rather than trusting what ingest returned, through
  // the SAME call replay uses — so a batch that materializes here is one that
  // can be rebuilt later, by construction rather than by assertion.
  return materialize(store, roots);
}
