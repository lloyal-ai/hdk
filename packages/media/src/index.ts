/**
 * @file `@lloyal-labs/media` — content, and the media that becomes it.
 *
 * This entry is **pure and browser-safe**: OCI shapes, the two ports a harness
 * injects, and the resolver replay runs. It imports nothing from the rest of
 * the HDK, which is what makes it a dependency root — `agents` and `rig` both
 * depend on it, and it depends on neither.
 *
 * Anything needing a runtime — the image normalizer (`sharp`), the filesystem
 * layout — is behind `@lloyal-labs/media/node`. The split is the boundary, not
 * a convention: `.` cannot import `./node`.
 *
 * **Two senses of "media" meet here.** OCI's sense is *typed bytes*
 * (`mediaType`, `sniffMediaType`); the modality sense is *pictures and sound*
 * (what a projector decodes). The format half is indifferent to modality — a
 * video or a rasterized page is the same manifest graph as an image.
 */
export {
  asAttachment, ATTACHMENT_ARTIFACT_TYPE, commitManifest, DERIVE_PREFIX, DIGEST_PATTERN,
  EMPTY_DESCRIPTOR, MANIFEST_TYPE, representationsOf, ROLE_ANNOTATION, sourceOf,
} from './attachment';
export type { Attachment, AttachmentManifest, Descriptor } from './attachment';

export { NullAttachmentStore } from './store';
export type { AttachmentStore } from './store';

export { materialize, NoContentIngress } from './ingress';
export type { ContentIngress, PreparedContent } from './ingress';

export { PROJECTOR_FORMATS, sniffMediaType, UNKNOWN_MEDIA_TYPE } from './media-type';
