import { call } from 'effection';
import type { Operation } from 'effection';
import { Tool } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema, ToolContext } from '@lloyal-labs/lloyal-agents';
import { mergeRanges, subtractRanges } from '@lloyal-labs/rig';
import { pagesOf } from '@lloyal-labs/media';
import { pageCite, unknownDocument, NO_DOCUMENTS } from '../documents-index';
import type { DocumentsIndex } from '../documents-index';
import type { IndexFor } from './search-documents';

/**
 * The exact text of a document: a page, or a line range from a search hit.
 * A page reads as the whole sections that touch it, so a table split by a
 * page break stays whole. Per-agent read tracking returns only the unread
 * part, as the corpus reader does.
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
  private readonly _read = new Map<string, [number, number][]>();

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

    // [s, e): 0-based start, exclusive end — the range helpers' convention.
    let s: number;
    let e: number;
    if (args.page !== undefined) {
      const page = doc.meta.pages.find((p) => p.page === args.page);
      if (!page) return { error: `Page ${args.page} is out of range: ${doc.meta.title} has ${doc.meta.pageCount} pages.` };
      const covering = doc.meta.sections.filter((sec) => sec.pageStart <= page.page && page.page <= sec.pageEnd);
      s = (covering.length > 0 ? Math.min(...covering.map((c) => c.startLine)) : page.startLine) - 1;
      e = covering.length > 0 ? Math.max(...covering.map((c) => c.endLine)) : page.endLine;
    } else {
      s = Math.max(0, (args.startLine ?? 1) - 1);
      e = Math.min(lines.length, args.endLine ?? s + this._defaultMaxLines);
    }
    if (e <= s) return { error: `Nothing to read: lines ${s + 1}-${e} of ${doc.meta.title}.` };

    const key = `${context?.agentId ?? ''}:${doc.id}`;
    const prev = this._read.get(key) ?? [];
    const unread = subtractRanges([s, e], prev);
    if (unread.length === 0) return { document: doc.meta.title, id: doc.id, note: `Lines ${s + 1}-${e} already read` };
    this._read.set(key, mergeRanges([...prev, [s, e]]));

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
}
