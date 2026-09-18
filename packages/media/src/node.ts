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

// The document codec and the dispatching ingress. `@embedpdf/pdfium` is an
// OPTIONAL peer like sharp: required at call time, never at import.
export { createDocumentIngress, createCodec, openDocument, PdfError, MAX_DOCUMENT_BYTES, DOCUMENT_TIMEOUT_MS, MAX_RENDERED_PAGES, MAX_TEXT_PAGES, MAX_FIGURES, RENDER_PROFILE } from './pdf';
export type { DocumentOpts } from './pdf';
export { createContentIngress, DOCUMENT_UPLOAD_TIMEOUT_MS } from './content-ingress';
export { gate, createGate, MAX_CONCURRENT_NORMALIZATIONS, MAX_QUEUED_NORMALIZATIONS, PERMIT_WAIT_TIMEOUT_MS } from './gate';
export type { Gate } from './gate';
