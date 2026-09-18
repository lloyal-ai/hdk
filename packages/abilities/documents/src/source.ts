import { Source } from '@lloyal-labs/lloyal-agents';
import type { Tool, Chunk } from '@lloyal-labs/lloyal-agents';
import type { Reranker, Document } from '@lloyal-labs/rig';
import { loadDocuments } from '@lloyal-labs/rig';
import type { Attachment, AttachmentStore } from '@lloyal-labs/media';

/** Data for the harness to place — once, in shared KV. */
export type DocumentsPromptData = {
  /** One line per attached document: title, page count, top-level topics. */
  toc: string;
};

/** Titles and headings are model-facing prose from a user's file: control
 *  characters (Unicode category Cc) go, whitespace collapses, length is capped. */
const MAX_LABEL = 120;
const MAX_TOPICS = 8;
function label(text: string): string {
  const clean = text.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > MAX_LABEL ? `${clean.slice(0, MAX_LABEL - 1)}…` : clean;
}

/** The table of contents for a set of documents: `<title> — <n> pages (topics: …)`. */
export function buildToc(documents: readonly Document[]): string {
  return documents.map((d) => {
    const title = label(d.meta.title);
    const topics: string[] = [];
    for (const s of d.meta.sections) {
      if (s.path.includes(' > ')) continue;
      const heading = label(s.heading);
      if (heading === title || topics.includes(heading)) continue;
      topics.push(heading);
      if (topics.length >= MAX_TOPICS) break;
    }
    const pages = `${d.meta.pageCount} page${d.meta.pageCount === 1 ? '' : 's'}`;
    return topics.length > 0 ? `${title} — ${pages} (topics: ${topics.join(', ')})` : `${title} — ${pages}`;
  }).join('\n');
}

/**
 * The documents source: `search_documents`, `read_document` and `view_page`
 * over the documents available to a run. The tools read the run's assets per
 * call; this class holds only what is per session — the store and the tools.
 */
export class DocumentsSource extends Source<Chunk> {
  /** @inheritDoc */
  readonly name = 'documents';
  private readonly _store: AttachmentStore;
  private readonly _tools: Tool[];

  constructor(store: AttachmentStore, tools: Tool[], reranker: Reranker) {
    super();
    this._store = store;
    this._tools = tools;
    this._reranker = reranker;
  }

  /** @inheritDoc */
  get tools(): Tool[] {
    return this._tools;
  }

  /**
   * The table of contents of the documents among `attachments` — the assets
   * the run is being staged with — for the harness to place on the spine.
   * Built from the sidecars alone: no tokenizing, no index.
   */
  override promptData(attachments: readonly Attachment[] = []): DocumentsPromptData {
    return { toc: buildToc(loadDocuments(this._store, attachments)) };
  }
}
