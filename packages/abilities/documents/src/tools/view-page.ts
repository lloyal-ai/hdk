import { call } from 'effection';
import type { Operation } from 'effection';
import { Tool, TOOL_ATTACHMENTS_KEY, CallingAgent } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema, ToolContext } from '@lloyal-labs/lloyal-agents';
import type { DocumentMeta } from '@lloyal-labs/media';
import { pageCite, unknownDocument, NO_DOCUMENTS } from '../documents-index';
import type { DocumentsIndex } from '../documents-index';
import type { IndexFor } from './search-documents';

/** The per-page facts the sidecar records. */
export type PageFacts = DocumentMeta['pages'][number];

/** How many drawing operations make a page "has graphics". */
const PATH_OBJECTS_FOR_GRAPHICS = 20;

/**
 * The projection rule: which pages are worth a model's attention as an image.
 * The facts are the sidecar's; the rule lives here, with the tool that spends
 * the cells. Page one always (the title page carries the figure of record
 * more often than not); a page with no extractable text (scanned); a page
 * with images, drawings, tagged tables or tagged figures.
 */
export function projectable(page: PageFacts): boolean {
  return page.page === 1
    || page.chars === 0
    || page.imageObjects > 0
    || page.pathObjects >= PATH_OBJECTS_FOR_GRAPHICS
    || page.taggedTables > 0
    || page.taggedFigures > 0;
}

/**
 * Put a page — or one figure on it — in front of the model. The result names
 * the page root (or figure root) under the framework's attachment key as a
 * DESCRIPTOR: no bytes, no ingress, no normalizer permit; the pool resolves it
 * through the store and admits it on the media rail. A text-only page says
 * so instead, and a page past the render bound says it is not archived.
 *
 * A repeat by the same agent carries the page AGAIN, with a note. The tool
 * cannot see whether its last result landed — the pool may have replaced it
 * with a settle nudge — so suppressing a repeat would leave the model blind;
 * admission is the only gate on what a page costs.
 */
export class ViewPageTool extends Tool<{ document: string; page: number; figure?: number }> {
  readonly name = 'view_page';
  readonly protected = false;
  readonly description = 'Look at a page of an attached document as an image — for a table, chart or figure, after reading the text around it. `figure` picks one figure on the page by its number.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      document: { type: 'string', description: 'Document id or title' },
      page: { type: 'number', description: 'Page number, from search or read_document results' },
      figure: { type: 'number', description: 'Which figure on the page (1 = first), to view just the figure' },
    },
    required: ['document', 'page'],
  };

  private readonly _indexFor: IndexFor;

  constructor(indexFor: IndexFor) {
    super();
    this._indexFor = indexFor;
  }

  *execute(args: { document: string; page: number; figure?: number }, context?: ToolContext): Operation<unknown> {
    const index: DocumentsIndex = yield* call(() => this._indexFor(context?.attachments ?? []));
    if (index.documents.length === 0) return { error: NO_DOCUMENTS };
    const doc = index.find(args.document ?? '');
    if (!doc) return { error: unknownDocument(args.document ?? '', index) };
    const page = doc.meta.pages.find((p) => p.page === args.page);
    if (!page) return { error: `Page ${args.page} is out of range: ${doc.meta.title} has ${doc.meta.pageCount} pages.` };

    const where = { document: doc.meta.title, id: doc.id, page: page.page };
    // "Before" means the model actually received it, which only the agent's
    // booked history knows — a view the pool rejected never happened.
    const agent = yield* CallingAgent.get();
    const seen = !!agent && agent.attendedResults(this.name).some((a) =>
      index.find(String(a.document ?? ''))?.id === doc.id
      && a.page === page.page
      && (a.figure ?? undefined) === args.figure);
    const again = seen
      ? { note: args.figure !== undefined ? `You viewed figure ${args.figure} on page ${page.page} before.` : `You viewed page ${page.page} before.` }
      : {};

    if (args.figure !== undefined) {
      const figures = doc.meta.figures.filter((f) => f.page === page.page);
      const fig = figures[args.figure - 1];
      if (!fig) {
        return { error: figures.length === 0
          ? `Page ${page.page} has no figures.`
          : `Page ${page.page} has ${figures.length} figure(s); figure must be between 1 and ${figures.length}.` };
      }
      return { ...where, ...again, figure: args.figure, ...(fig.caption ? { caption: fig.caption } : {}),
        cite: pageCite(doc.attachment, page.page), [TOOL_ATTACHMENTS_KEY]: [fig.root] };
    }

    if (!projectable(page)) return { ...where, note: `Page ${page.page} is text only — read_document gives you its text.` };
    if (!page.render) return { ...where, note: `Page ${page.page} is not archived as an image.` };
    return { ...where, ...again, cite: pageCite(doc.attachment, page.page), [TOOL_ATTACHMENTS_KEY]: [page.render] };
  }
}
