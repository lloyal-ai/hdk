import { call } from 'effection';
import type { Operation } from 'effection';
import { Tool, CallingAgent } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema, ToolContext } from '@lloyal-labs/lloyal-agents';
import { mergeRanges, subtractRanges } from '@lloyal-labs/rig';
import type { Document } from '@lloyal-labs/rig';
import { pagesOf } from '@lloyal-labs/media';
import { pageCite, unknownDocument, NO_DOCUMENTS } from '../documents-index';
import type { DocumentsIndex } from '../documents-index';
import type { IndexFor } from './search-documents';

/**
 * The exact text of a document: a page, or a line range from a search hit.
 * A page reads as the whole sections that touch it, so a table split by a
 * page break stays whole. Only the unread part comes back, and what counts as
 * read is what the calling agent has actually RECEIVED — its own landed calls
 * and its ancestors'. The tool keeps no memory of its own: it cannot see
 * whether its last result was admitted, so a settle rejection would otherwise
 * leave the model blind on the retry.
 */
export class ReadDocumentTool extends Tool<{ document: string; page?: number; startLine?: number; endLine?: number }> {
  readonly name = 'read_document';
  readonly protected = false;
  readonly description = 'Read the exact text of an attached document: a whole page, or a line range from search results. Name the document by id or title.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      document: { type: 'string', description: 'Document id or title, from search results or the briefing' },
      page: { type: 'number', description: 'Page number — returns every section that touches the page' },
      startLine: { type: 'number', description: 'Start line (1-indexed, from search results)' },
      endLine: { type: 'number', description: 'End line (1-indexed, from search results)' },
    },
    required: ['document'],
  };

  private readonly _indexFor: IndexFor;
  private readonly _defaultMaxLines: number;

  constructor(indexFor: IndexFor, opts?: { defaultMaxLines?: number }) {
    super();
    this._indexFor = indexFor;
    this._defaultMaxLines = opts?.defaultMaxLines ?? 100;
  }

  *execute(
    args: { document: string; page?: number; startLine?: number; endLine?: number },
    context?: ToolContext,
  ): Operation<unknown> {
    const index: DocumentsIndex = yield* call(() => this._indexFor(context?.attachments ?? []));
    if (index.documents.length === 0) return { error: NO_DOCUMENTS };
    const doc = index.find(args.document ?? '');
    if (!doc) return { error: unknownDocument(args.document ?? '', index) };
    const lines = doc.resource.content.split('\n');

    const span = this._spanOf(doc, args, lines.length);
    if (!span) return { error: `Page ${args.page} is out of range: ${doc.meta.title} has ${doc.meta.pageCount} pages.` };
    const [s, e] = span;
    if (e <= s) return { error: `Nothing to read: lines ${s + 1}-${e} of ${doc.meta.title}.` };

    // What this agent already attends over of THIS document. Each past call is
    // resolved by the same rule as the present one, because the pool books the
    // model's raw arguments: a landed `{ page: 2 }` carries no line numbers,
    // and only this document's section map turns it into a span.
    const agent = yield* CallingAgent.get();
    const prev = agent
      ? mergeRanges(
          agent.attendedResults(this.name)
            .filter((a) => index.find(String(a.document ?? ''))?.id === doc.id)
            .map((a) => this._spanOf(doc, a, lines.length))
            .filter((x): x is [number, number] => x !== null),
        )
      : [];
    const unread = subtractRanges([s, e], prev);
    if (unread.length === 0) return { document: doc.meta.title, id: doc.id, note: `Lines ${s + 1}-${e} already read` };

    const content = unread.map(([a, b]) => lines.slice(a, b).join('\n')).join('\n...\n');
    const { pageStart, pageEnd } = pagesOf(doc.meta, s + 1, e);
    return {
      document: doc.meta.title, id: doc.id,
      lines: unread.map(([a, b]) => `${a + 1}-${b}`),
      pageStart, pageEnd,
      cite: pageCite(doc.attachment, pageStart),
      content,
    };
  }

  /**
   * The half-open line span a call names — `[s, e)` — or null when it names a
   * page this document does not have.
   *
   * The same rule serves the present call and every past one, so "what did
   * that read deliver" cannot drift from "what does this read ask for". A page
   * resolves through the sections that touch it, which is why no generic range
   * helper can do this: the answer lives in the document, not in the numbers.
   */
  private _spanOf(
    doc: Document,
    args: { page?: unknown; startLine?: unknown; endLine?: unknown },
    lineCount: number,
  ): [number, number] | null {
    if (typeof args.page === 'number') {
      const page = doc.meta.pages.find((p) => p.page === args.page);
      if (!page) return null;
      const covering = doc.meta.sections.filter((sec) => sec.pageStart <= page.page && page.page <= sec.pageEnd);
      const s = (covering.length > 0 ? Math.min(...covering.map((c) => c.startLine)) : page.startLine) - 1;
      const e = covering.length > 0 ? Math.max(...covering.map((c) => c.endLine)) : page.endLine;
      return [s, e];
    }
    const s = Math.max(0, (typeof args.startLine === 'number' ? args.startLine : 1) - 1);
    const e = Math.min(lineCount, typeof args.endLine === 'number' ? args.endLine : s + this._defaultMaxLines);
    return [s, e];
  }
}
