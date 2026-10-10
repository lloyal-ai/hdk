/**
 * @file The one loading door: bytes in, an attachment out, the bytes deciding
 * what they are.
 *
 * `ContentIngress` stays one port. A host installs this on its content routes
 * and on the agents `Ingress` context, and an upload or a tool result that
 * carries bytes goes through the same dispatch: an image to the normalizer, a
 * PDF to the document ingress. A caller never declares a type; the signature
 * does.
 */
import type { AttachmentStore } from './store';
import type { ContentIngress } from './ingress';
import { sniffMediaType } from './media-type';
import { createImageIngress } from './image';
import type { NormalizeOpts } from './image';
import { createDocumentIngress } from './pdf';
import type { DocumentOpts } from './pdf';
import { createAudioIngress } from './audio-ingress';
import type { AudioIngressOptions } from './audio-ingress';

/**
 * How long a host should allow an upload that may be a document, end to end:
 * transfer plus the document's own time bound. The route's default is sized
 * for images; a host that installs this ingress passes this beside
 * `MAX_DOCUMENT_BYTES`, so every host that mounts the plane admits the same.
 *
 * @category Media
 */
export const DOCUMENT_UPLOAD_TIMEOUT_MS = 180_000;

/**
 * @category Media
 */
export function createContentIngress(
  store: AttachmentStore,
  opts: { image?: NormalizeOpts; document?: DocumentOpts; audio?: AudioIngressOptions } = {},
): ContentIngress {
  const image = createImageIngress(store, opts.image);
  const document = createDocumentIngress(store, opts.document);
  const audio = createAudioIngress(store, opts.audio);
  const formats: Record<string, ContentIngress> = { 'application/pdf': document, 'audio/wav': audio };
  return {
    ingest(bytes: Uint8Array, signal?: AbortSignal) {
      return (formats[sniffMediaType(bytes)] ?? image).ingest(bytes, signal);
    },
  };
}
