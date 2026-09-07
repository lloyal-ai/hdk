/**
 * @file From the assets available to a run to a searchable value.
 *
 * A function from attachments to an index: the same attachments give the same
 * index. Each document is fitted once per digest and remembered, so a second
 * call in the same session — the next tool call, the next run of the thread —
 * re-tokenizes nothing. No sync step, no state machine: what a tool sees is
 * whatever is available to the run at the call, indexed.
 */
import { BM25Index, fitChunks, DEFAULT_CHUNK_TOKENS, loadDocuments } from '@lloyal-labs/rig';
import type { Document } from '@lloyal-labs/rig';
import type { Chunk } from '@lloyal-labs/lloyal-agents';
import type { Attachment, AttachmentStore } from '@lloyal-labs/media';

/** How many hex digits of the root digest make a document's handle. */
export const ID_LENGTH = 12;

/**
 * A document's handle: the first twelve hex digits of its root digest. It is
 * the asset's own identity, copied from tool output like any id — never an
 * ordinal three parties must order the same way. The UI resolves it against
 * the digests it already holds and requires exactly one match.
 */
export function documentId(root: Attachment): string {
  const hex = root.digest.slice(root.digest.indexOf(':') + 1);
  return hex.slice(0, ID_LENGTH);
}

/** The citation for a page: what the model copies into its report. */
export function pageCite(root: Attachment, page: number): string {
  return `attachment://${documentId(root)}/page/${page}`;
}

/** A loaded document with its handle. Its chunks and resource are named by the handle. */
export interface IndexedDocument extends Document {
  id: string;
}

export interface DocumentsIndex {
  documents: IndexedDocument[];
  /** Every document's fitted chunks, `resource` = the document id. */
  chunks: Chunk[];
  /** Lexical first stage over `chunks`; null when there is nothing to index. */
  bm25: BM25Index | null;
  /** By id, or by title (exact, case-insensitive). */
  find(document: string): IndexedDocument | undefined;
}

export type Tokenize = (text: string) => Promise<number[]>;

/**
 * Build the indexer for one session. Returns the function from attachments to
 * an index. Roots that are not documents (an image) are skipped. A root whose
 * content is missing or drifted throws, naming the digest — an empty index
 * behind a digest that promises content would be a silent wrong answer.
 */
export function documentIndexer(
  store: AttachmentStore,
  tokenize: Tokenize,
): (attachments: readonly Attachment[]) => Promise<DocumentsIndex> {
  type Fitted = { document: IndexedDocument; chunks: Chunk[] };
  const fitted = new Map<string, Promise<Fitted | null>>();
  const indices = new Map<string, Promise<DocumentsIndex>>();

  const fit = (root: Attachment): Promise<Fitted | null> => {
    let p = fitted.get(root.digest);
    if (!p) {
      p = (async () => {
        const [loaded] = loadDocuments(store, [root]);
        if (!loaded) return null;
        const id = documentId(root);
        const chunks = await fitChunks(
          loaded.chunks.map((c) => ({ ...c, resource: id })),
          { maxTokens: DEFAULT_CHUNK_TOKENS, tokenize },
        );
        const document: IndexedDocument = { ...loaded, id, resource: { name: id, content: loaded.resource.content } };
        return { document, chunks };
      })();
      fitted.set(root.digest, p);
      // A failure is not remembered: the next call asks the store again.
      p.catch(() => { fitted.delete(root.digest); });
    }
    return p;
  };

  return (attachments) => {
    // The same root attached twice is one document.
    const roots = [...new Map(attachments.map((a) => [a.digest, a] as const)).values()];
    const key = roots.map((r) => r.digest).join('\n');
    let index = indices.get(key);
    if (!index) {
      index = (async () => {
        const entries = (await Promise.all(roots.map(fit))).filter((e): e is Fitted => e !== null);
        const documents = entries.map((e) => e.document);
        const byId = new Map<string, IndexedDocument>();
        for (const d of documents) {
          const other = byId.get(d.id);
          if (other) {
            throw new Error(
              `documents: two attached documents share the handle ${d.id} ` +
              `(${other.attachment.digest} and ${d.attachment.digest}); a citation could not name one of them.`,
            );
          }
          byId.set(d.id, d);
        }
        const chunks = entries.flatMap((e) => e.chunks);
        const bm25 = chunks.length > 0 ? new BM25Index(chunks.map((c) => c.tokens)) : null;
        return {
          documents, chunks, bm25,
          find(document: string) {
            const needle = document.trim().toLowerCase();
            return byId.get(needle) ?? documents.find((d) => d.meta.title.toLowerCase() === needle);
          },
        };
      })();
      indices.set(key, index);
      index.catch(() => { indices.delete(key); });
    }
    return index;
  };
}

/** The error a tool returns for a document it cannot find: it lists what is attached. */
export function unknownDocument(asked: string, index: DocumentsIndex): string {
  const attached = index.documents.map((d) => `${d.meta.title} (${d.id})`).join(', ');
  return `Unknown document: ${asked}. Attached: ${attached || 'none'}.`;
}

/** The message when nothing is attached — the same from every tool. */
export const NO_DOCUMENTS = 'No documents are attached to this conversation.';
