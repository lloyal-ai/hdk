/**
 * @file The content-store contract, and the default that refuses media.
 *
 * The invariant it exists for: **anything that reaches model state must be
 * addressable, or the run is not replayable.** A trace records the media
 * marker, never the pixels, so without a content store a media-bearing run
 * cannot be rebuilt — which makes addressability a correctness requirement,
 * not telemetry, and is why it is never gated behind a dev flag.
 *
 * Pure — this entry is browser-safe by construction. The filesystem
 * implementation is `FileAttachmentStore` in `@lloyal-labs/media/node`, and a
 * project opens one through `createProjectMediaStore` in `@lloyal-labs/rig`:
 * the LAYOUT is format and ships with this package, while WHERE a project
 * keeps it is harness policy and stays with the harness.
 */

import type { Attachment, AttachmentManifest, Descriptor } from './attachment';

/**
 * Content a caller holds a reference to is not in the store, or its bytes no
 * longer hash to its digest. The one error `materialize` and `resolveVideo`
 * raise for it, so a caller rebuilding model state from references can tell
 * "the content is gone" from a store that is broken: a heal stands down on
 * this alone, and lets any other error reach the run as the error it is.
 */
export class ContentLost extends Error {
  constructor(detail: string) {
    super(`content lost: ${detail}`);
    this.name = 'ContentLost';
  }
}

/**
 * Content store for a run's media.
 *
 * Read from the {@link Attachments} Effection context, which defaults to
 * {@link NullAttachmentStore}.
 *
 * **One failure convention: writes THROW, lookups return nothing.** A write
 * that cannot happen is a failure and says why; asking about content that was
 * never stored is a normal question with a normal answer.
 *
 * This doc used to say the opposite — "writes must not throw", the cost
 * deferred to a replay that refuses loudly — while the null object below it
 * threw, the filesystem store returned null, and the one production caller
 * converted every null back into a throw with a message that had lost the
 * actual reason. Three conventions for one question.
 *
 * The deferral argument does not survive contact with the order of writes:
 * when the REPRESENTATION write fails, `putAttachment` never runs, so no
 * manifest exists and replay has nothing to refuse. The safety net it appealed
 * to is not there, and the run carries on with media in the cache and no
 * record of it — the exact silent outcome the addressability rule exists to
 * prevent.
 *
 * @category Media
 */
export interface AttachmentStore {
  /** Store bytes, return their descriptor. Idempotent by content.
   *
   *  @throws If the bytes could not be stored, carrying the underlying reason. */
  putBlob(bytes: Uint8Array, mediaType: string, annotations?: Record<string, string>): Descriptor;
  /** Compose a conformant manifest from semantic parts, store it, and record
   *  it as one of this store's manifests. Callers never author a manifest
   *  themselves, so a non-conformant one cannot reach disk, and only what was
   *  committed here is ever read back as a manifest ({@link getManifest}).
   *
   *  @throws If there is no representation, or the manifest could not be
   *          stored or recorded. `layers` must hold at least one descriptor to
   *          be valid, and an attachment where nothing reached the cache is
   *          meaningless. */
  putAttachment(parts: {
    representations: readonly Descriptor[];
    source?: Descriptor;
    /** Typed structured metadata about the attachment as a whole, stored as
     *  its own blob. Omit for an image, which has nothing to say beyond its
     *  layers — the manifest then carries {@link EMPTY_DESCRIPTOR}.
     *
     *  This slot exists because annotations are `map<string,string>`, and
     *  timed media will need more than strings: a timeline, track
     *  descriptors, the sampling policy, frame-to-audio correspondence.
     *  Encoding that as JSON inside an annotation would be unvalidatable, and
     *  a typed config blob is what OCI provides the slot for. A reader
     *  branches on `config.mediaType`, so adding one later is additive. */
    config?: { bytes: Uint8Array; mediaType: string };
    annotations?: Record<string, string>;
  }): Attachment;
  /** Resolve blob bytes by digest: the bytes that HASH TO IT, or `null`.
   *
   *  Resolution goes STRAIGHT to `blobs/<algorithm>/<encoded>`: a blob's
   *  identity is its digest, and nothing else is consulted. Which blobs are
   *  manifests is a different question, answered by what the store committed
   *  ({@link getManifest}).
   *
   *  Every read of a whole blob (this one and {@link readWhole}) rehashes what
   *  it found; bytes that no longer match the name —
   *  bit rot, a torn write, a rewritten file — answer `null` exactly as an
   *  absent blob does. A property of the store, not a per-call option: replay
   *  rebuilding cells from drifted bytes under the original digest is a silent
   *  divergence, and the HTTP route serving them under that digest's ETag is
   *  the same lie one hop later. (Verification was briefly a flag that replay
   *  switched on; the manifest lookup beside it never got the flag, which left
   *  the root-to-bytes chain unverified. One rule for every whole read; only
   *  {@link size} and {@link readRange}, which never hold a whole blob, are
   *  outside it, and their docs say so.) */
  get(digest: string): Uint8Array | null;
  /** Resolve and validate a manifest this store committed through
   *  {@link putAttachment}. `null` when it committed none under this digest,
   *  or the one it did is drifted (it is read through {@link get}), unparsable,
   *  or not an artifact type this build understands.
   *
   *  A blob that merely parses as a manifest is not one. A manifest names the
   *  media type each of its layers is served and decoded under; composed by
   *  the store those types are what the host established about the bytes,
   *  and a blob anyone could write would carry whatever its writer chose. So
   *  the store keeps the record of what it committed, and a digest outside
   *  that record is a blob, whatever it contains. */
  getManifest(digest: string): AttachmentManifest | null;
  /** A stored blob's size in bytes, or `null` when it is not stored. Reads no
   *  content, so it does not verify it: a question about existence, not bytes. */
  size(digest: string): number | null;
  /** Stream part of a blob, `start` to `end` inclusive, or `null` when it is
   *  not stored. **Not verified:** a range cannot be checked against a digest
   *  of the whole. Playback seeks through this; whatever reaches the model or
   *  replay goes through {@link get}, which verifies every byte. */
  readRange(digest: string, range: { start: number; end: number }): ReadableStream<Uint8Array> | null;
  /** Stream a whole blob in bounded memory, or `null` when it is not stored.
   *  Verified like {@link get}, but as it goes: the last bytes are released only
   *  once the whole hashes to its digest, and on a mismatch the stream errors
   *  instead, so a reader never receives a complete body under the wrong name.
   *  For blobs too large to hold, such as a retained original. */
  readWhole(digest: string): ReadableStream<Uint8Array> | null;
}

/**
 * The default store: inert for text, loud for media.
 *
 * A text-only run never reaches a write here and pays nothing — which is why
 * this stays the context default and `.expect()` never throws.
 *
 * Every write throws, because there is no such thing as a successful write to
 * a store that does not exist. A harness that accepts media installs a real
 * one; a harness that does not is told at the first image rather than at
 * replay, months later. Reads return nothing, like any other store asked for
 * content it does not hold.
 *
 * @category Media
 */
export class NullAttachmentStore implements AttachmentStore {
  // Every method carries the FULL contract signature even where it ignores the
  // arguments. Narrowing them (`putBlob(bytes)`, `get()`) still satisfies
  // `implements`, but a caller holding the concrete type then sees a different
  // API than the interface promises — `putBlob(bytes, mediaType)` fails to
  // compile against the null object while compiling against every other store.
  putBlob(
    _bytes: Uint8Array,
    _mediaType?: string,
    _annotations?: Record<string, string>,
  ): Descriptor {
    throw new Error(
      'No content store installed, so this media cannot be addressed — and ' +
        'unaddressed media makes the run unreplayable. Install a store ' +
        '(`createProjectMediaStore` from @lloyal-labs/rig) and set it on the ' +
        'Attachments context.',
    );
  }
  putAttachment(_parts?: unknown): Attachment {
    throw new Error(
      'No content store installed, so this attachment cannot be committed.',
    );
  }
  get(_digest?: string): Uint8Array | null { return null; }
  getManifest(_digest?: string): AttachmentManifest | null { return null; }
  size(_digest?: string): number | null { return null; }
  readRange(_digest?: string, _range?: { start: number; end: number }): ReadableStream<Uint8Array> | null { return null; }
  readWhole(_digest?: string): ReadableStream<Uint8Array> | null { return null; }
}
