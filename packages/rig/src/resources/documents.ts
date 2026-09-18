/**
 * @file From document attachments in the content store to the resources and
 * chunks the retrieval stack already understands.
 *
 * A document attachment is a manifest whose one representation is
 * `text/markdown` and whose config is the sidecar (`DocumentMeta`). Nothing
 * here parses markdown: the sidecar's sections already say where each one
 * starts and ends, so a chunk is a line slice. No codec, no native addon —
 * this module is pure and sits on the platform-agnostic barrel.
 */
import { representationsOf, asDocumentMeta, DOCUMENT_CONFIG_TYPE } from '@lloyal-labs/media';
import type { Attachment, AttachmentManifest, AttachmentStore, DocumentMeta } from '@lloyal-labs/media';
import type { Resource, Chunk } from '@lloyal-labs/lloyal-agents';

/**
 * A document as retrieval sees it: the root it came from, the sidecar, and
 * the resource and section chunks cut from its markdown.
 *
 * @category Rig
 */
export interface Document {
  attachment: Attachment;
  manifest: AttachmentManifest;
  meta: DocumentMeta;
  resource: Resource;
  /** One chunk per sidecar section, `tokens` empty — size them with `fitChunks`. */
  chunks: Chunk[];
}

/**
 * Load the documents among `roots`. A root whose config is not a document
 * sidecar (an image, say) is skipped — it is legitimately something else.
 * A root whose manifest or blobs are missing or drifted THROWS, naming the
 * digest: silent degradation here would index an empty document behind a
 * digest that promises content.
 *
 * Resource names are the documents' titles, deduplicated in order
 * (`Title`, `Title (2)`), so two uploads with one title stay addressable.
 *
 * @category Rig
 */
export function loadDocuments(store: AttachmentStore, roots: readonly Attachment[]): Document[] {
  const out: Document[] = [];
  const seen = new Map<string, number>();
  const short = (digest: string): string => `${digest.slice(0, 19)}…`;
  for (const attachment of roots) {
    const manifest = store.getManifest(attachment.digest);
    if (!manifest) {
      throw new Error(`loadDocuments: attachment manifest ${short(attachment.digest)} is not in the content store, or its bytes no longer hash to its digest.`);
    }
    if (manifest.config.mediaType !== DOCUMENT_CONFIG_TYPE) continue;
    const configBytes = store.get(manifest.config.digest);
    if (!configBytes) throw new Error(`loadDocuments: sidecar ${short(manifest.config.digest)} is missing from the content store or has drifted.`);
    const meta = asDocumentMeta(JSON.parse(new TextDecoder().decode(configBytes)));
    if (!meta) throw new Error(`loadDocuments: sidecar ${short(manifest.config.digest)} is not a ${DOCUMENT_CONFIG_TYPE} record.`);
    const markdown = representationsOf(manifest).find((r) => r.mediaType === 'text/markdown');
    if (!markdown) throw new Error(`loadDocuments: document ${short(attachment.digest)} carries no text/markdown representation.`);
    const bytes = store.get(markdown.digest);
    if (!bytes) throw new Error(`loadDocuments: markdown ${short(markdown.digest)} is missing from the content store or has drifted.`);
    const content = new TextDecoder().decode(bytes);

    const n = (seen.get(meta.title) ?? 0) + 1;
    seen.set(meta.title, n);
    const name = n === 1 ? meta.title : `${meta.title} (${n})`;
    const lines = content.split('\n');
    const chunks: Chunk[] = meta.sections
      .map((s) => ({
        resource: name,
        heading: s.heading,
        section: s.path,
        text: lines.slice(s.startLine - 1, s.endLine).join('\n'),
        tokens: [],
        startLine: s.startLine,
        endLine: s.endLine,
      }))
      .filter((c) => c.text.trim().length > 0);
    out.push({ attachment, manifest, meta, resource: { name, content }, chunks });
  }
  return out;
}
