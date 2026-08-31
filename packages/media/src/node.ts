/**
 * @file `@lloyal-labs/media/node` — the half that needs a runtime.
 *
 * Two independent things live behind this entry, and they are separate files
 * for the same reason they are separate concerns: the normalizer decides what
 * pixels are admitted, the layout decides how bytes are stored, and neither
 * changes when the other does.
 *
 * `sharp` is an OPTIONAL peer. A consumer that only reads and writes content
 * never installs it; one that normalizes does, and the manifest says so.
 */
export { createImageIngress, DEFAULT_MAX_PIXELS, normalizeImage } from './image';
export type { NormalizedImage, NormalizeImage, NormalizeOpts } from './image';

export { FileAttachmentStore } from './file-store';
