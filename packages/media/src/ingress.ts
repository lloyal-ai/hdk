/**
 * @file Where raw media becomes admitted content, and content becomes bytes.
 *
 * The PORT (`ContentIngress`) and the pure resolver (`materialize`) — the two
 * halves that need nothing but this package. Whoever drives them across a
 * batch is an orchestration concern and lives with the orchestrator.
 */
import { representationsOf } from './attachment';
import { PROJECTOR_FORMATS } from './media-type';
import { resolveSoundtrack, resolveVideo, VIDEO_CONFIG_TYPE } from './video';
import { AUDIO_CONFIG_TYPE, resolveAudio } from './audio';
import type { AudioAdmission } from './audio';
import type { VideoInput } from './video';
import type { Attachment } from './attachment';
import { ContentLost } from './store';
import type { AttachmentStore } from './store';

/**
 * One projector input, behind one marker: an image's admitted bytes, a
 * video's frames on its timeline, or a recording's samples. Structurally the
 * SDK's `MultimodalInput`.
 *
 * @category Media
 */
export type ProjectorInput = Uint8Array | VideoInput | { kind: 'audio'; bytes: Uint8Array };

/** What the projector reading the content can take. */
export interface MaterializeOpts {
  /** The projector hears, and a recording, or a video's soundtrack window, must meet this admission to reach it.
   *  Absent, sound contributes no input: a recording reaches a transcriber instead, and a video its frames and
   *  transcript alone. */
  audio?: AudioAdmission;
}

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
  /** One input per marker, in root order: each image representation as its
   *  admitted bytes, each video as ONE input of its frames on their timeline,
   *  then, when the projector hears, one audio input per soundtrack window, and
   *  each recording as one audio input when the projector hears. A document,
   *  whose representation is text, contributes none. These are the EXACT
   *  inputs to hand a builder and then the projector. */
  inputs: readonly ProjectorInput[];
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
 * @throws {ContentLost} If any root or blob is missing or has drifted from its digest.
 *         Silent degradation here would rebuild a different KV state behind
 *         an identical-looking prompt.
 *
 * @category Media
 */
export function materialize(
  store: AttachmentStore,
  roots: readonly Attachment[],
  opts: MaterializeOpts = {},
): PreparedContent {
  const inputs: ProjectorInput[] = [];
  for (const root of roots) {
    const manifest = store.getManifest(root.digest);
    if (!manifest) {
      throw new ContentLost(
        `attachment manifest ${root.digest.slice(0, 19)}… is not ` +
          'in the content store, or its bytes no longer hash to its digest.',
      );
    }
    // A video's frames are not still images: they reach the projector as one
    // input, so they fuse on their timeline instead of encoding one by one.
    if (manifest.config.mediaType === VIDEO_CONFIG_TYPE) {
      inputs.push(resolveVideo(store, root));
      if (opts.audio) inputs.push(...resolveSoundtrack(store, root, opts.audio).map(bytes => ({ kind: 'audio' as const, bytes })));
      continue;
    }
    if (manifest.config.mediaType === AUDIO_CONFIG_TYPE) {
      if (opts.audio) inputs.push({ kind: 'audio', bytes: resolveAudio(store, root, opts.audio).bytes });
      continue;
    }
    for (const rep of representationsOf(manifest)) {
      // Only what the projector decodes is an input. A text representation is
      // real content — retrieval reads it — but handing it to the image decoder
      // would poison the branch it was prefilled on.
      if (!PROJECTOR_FORMATS.includes(rep.mediaType)) continue;
      // Replay rebuilds KV from these bytes under this digest. The store
      // refuses bytes that drifted from their name, so null here means absent
      // or drifted — either must refuse, not decode as something else.
      const bytes = store.get(rep.digest);
      if (!bytes) {
        throw new ContentLost(
          `blob ${rep.digest.slice(0, 19)}… (${rep.mediaType}) is ` +
            'referenced by a manifest but missing from the content store, or its ' +
            'bytes no longer hash to its digest.',
        );
      }
      inputs.push(bytes);
    }
  }
  return { attachments: roots, inputs };
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
  // Full contract signature, unused: a caller holding the CONCRETE type can
  // still write `ingress.ingest(bytes)` — the same reason
  // NullAttachmentStore keeps full signatures in store.ts.
  ingest(_bytes?: Uint8Array, _signal?: AbortSignal): Promise<Attachment> {
    return Promise.reject(new Error(
      'No content ingress installed, so this media cannot be normalized or ' +
        'addressed — and unaddressed media makes the run unreplayable. ' +
        'Install one (`createImageIngress` from @lloyal-labs/media/node) and ' +
        'set it on the Ingress context.',
    ));
  }
}
