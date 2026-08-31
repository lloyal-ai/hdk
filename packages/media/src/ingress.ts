/**
 * @file Where raw media becomes admitted content, and content becomes bytes.
 *
 * The PORT (`ContentIngress`) and the pure resolver (`materialize`) — the two
 * halves that need nothing but this package. Whoever drives them across a
 * batch is an orchestration concern and lives with the orchestrator.
 */
import { representationsOf } from './attachment';
import type { Attachment } from './attachment';
import type { AttachmentStore } from './store';

/**
 * Admitted content, ready for a delta builder.
 *
 * Deliberately NOT a delta: the builders are role-specific — a user turn, a
 * spine header and a tool result each need a different prompt, callId or
 * separator — so returning one would drag prompt composition into the content
 * layer. This is the seam where all three converge, and they differ only in
 * how the raw bytes arrived.
 *
 * @category Media
 */
export interface PreparedContent {
  /** Roots, in ingest order — what the trace and the fold carry. */
  attachments: readonly Attachment[];
  /** Every root's representations, flattened in order — the EXACT bytes to
   *  hand a builder and then the projector. One image contributes one; a video
   *  contributes its sampled frames. */
  bitmaps: readonly Uint8Array[];
}

/**
 * Expand root descriptors to the exact bytes that were admitted.
 *
 * The source is never returned: it is what the user brought, not what the
 * model saw, and replaying it would rebuild different cells under different
 * derivation parameters.
 *
 * Needs only the store, so it is safe on every runtime — unlike ingest, which
 * needs a native normalizer.
 *
 * @throws If any root or blob is missing. Silent degradation here would
 *         rebuild a different KV state behind an identical-looking prompt.
 *
 * @category Media
 */
export function materialize(
  store: AttachmentStore,
  roots: readonly Attachment[],
): PreparedContent {
  const bitmaps: Uint8Array[] = [];
  for (const root of roots) {
    const manifest = store.getManifest(root.digest);
    if (!manifest) {
      throw new Error(
        `materialize: attachment manifest ${root.digest.slice(0, 19)}… is not ` +
          'in the content store.',
      );
    }
    for (const rep of representationsOf(manifest)) {
      const bytes = store.get(rep.digest);
      if (!bytes) {
        throw new Error(
          `materialize: blob ${rep.digest.slice(0, 19)}… (${rep.mediaType}) is ` +
            'referenced by a manifest but missing from the content store.',
        );
      }
      bitmaps.push(bytes);
    }
  }
  return { attachments: roots, bitmaps };
}

/**
 * Turns raw bytes into admitted content: normalize, commit, return the root.
 *
 * One implementation serves all three ingresses. Injected rather than imported
 * because normalizing needs a native dependency (`sharp`) that this entry must
 * never pull — it is browser-safe by construction, and `agents`, which drives
 * it, has zero static `node:` imports — and because the HTTP layer must not
 * decide what "admitted" means.
 *
 * @category Media
 */
export interface ContentIngress {
  /** Normalize, commit, and return the root.
   *
   *  **Takes only the bytes.** The type is not an argument because the bytes
   *  answer it and nothing else may: every caller used to sniff, pass the
   *  answer in, and have the ingress decode and prefer its own — the same
   *  question asked at four call sites and then re-asked here. The HTTP route
   *  was worse than redundant, forwarding a client's `Content-Type` header as
   *  authority over content it did not produce.
   *
   *  `signal` is the second parameter and does not undermine the first rule:
   *  the type is DATA ABOUT THE CONTENT, which the bytes answer, while this is
   *  LIFETIME, which only the caller knows. A plain `AbortSignal` because this
   *  is a boundary — an Effection scope hands one out via `useAbortSignal()`,
   *  and a Node request handler makes its own, so one standard primitive
   *  serves both and this package depends on neither.
   *
   *  REJECTS rather than resolving to nothing — the async form of the one
   *  convention {@link AttachmentStore} states: a write that cannot happen is
   *  a failure and says why. Resolving to null here would let a caller emit a
   *  marker for content nothing can resolve. */
  ingest(bytes: Uint8Array, signal?: AbortSignal): Promise<Attachment>;
}

/**
 * The default ingress: inert for text, loud for media.
 *
 * A harness that never accepts media pays nothing and never sees this. One
 * that does, without installing an ingress service, fails HERE — before any
 * prefill — rather than quietly feeding unnormalized, unaddressed bytes to the
 * projector and producing a run that cannot be replayed.
 *
 * @category Media
 */
export class NoContentIngress implements ContentIngress {
  ingest(): Promise<Attachment> {
    return Promise.reject(new Error(
      'No content ingress installed, so this media cannot be normalized or ' +
        'addressed — and unaddressed media makes the run unreplayable. ' +
        'Install one (`createImageIngress` from @lloyal-labs/media/node) and ' +
        'set it on the Ingress context.',
    ));
  }
}
