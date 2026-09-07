import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import type { ToolContext } from '@lloyal-labs/lloyal-agents';
import type { Attachment } from '@lloyal-labs/media';
import { documentIndexer, documentId, NO_DOCUMENTS } from '../src/documents-index';
import { ReadDocumentTool } from '../src/tools/read-document';
import { makeFixture, wordTokenize } from './helpers/fixture';

type Read = { document?: string; id?: string; lines?: string[]; pageStart?: number; pageEnd?: number; cite?: string; content?: string; note?: string; error?: string };

function setup() {
  const fx = makeFixture();
  const tool = new ReadDocumentTool(documentIndexer(fx.store, wordTokenize));
  const read = (args: { document: string; page?: number; startLine?: number; endLine?: number }, attachments: readonly Attachment[] = [fx.doc], agentId = 1) =>
    run(function* () { return (yield* tool.execute(args, { agentId, attachments } as ToolContext)) as Read; });
  return { ...fx, read };
}

describe('read_document', () => {
  it('reads a line range by id, and by title regardless of case', async () => {
    const { doc, read } = setup();
    const byId = await read({ document: documentId(doc), startLine: 3, endLine: 5 });
    expect(byId).toMatchObject({
      document: 'Fixture Paper', id: documentId(doc), lines: ['3-5'],
      pageStart: 1, pageEnd: 1, cite: `attachment://${documentId(doc)}/page/1`,
      content: '## Introduction\n\nIntro text alpha beta.',
    });
    const byTitle = await read({ document: 'fixture paper', startLine: 3, endLine: 5 }, [doc], 2);
    expect(byTitle.content).toBe(byId.content);
  });

  it('reads a page as the whole sections that touch it', async () => {
    const { doc, read } = setup();
    const r = await read({ document: documentId(doc), page: 2 });
    expect(r.lines).toEqual(['7-12']);
    expect(r.content!.startsWith('## Results')).toBe(true);
    expect(r.content).toContain('| baseline | 803 |');
    expect([r.pageStart, r.pageEnd]).toEqual([2, 2]);
    expect(r.cite).toBe(`attachment://${documentId(doc)}/page/2`);
  });

  it('the same agent re-reading gets a note; another agent reads', async () => {
    const { doc, read } = setup();
    await read({ document: documentId(doc), page: 2 });
    const again = await read({ document: documentId(doc), page: 2 });
    expect(again.note).toMatch(/already read/);
    expect(again.content).toBeUndefined();
    const other = await read({ document: documentId(doc), page: 2 }, [doc], 7);
    expect(other.content).toContain('| baseline | 803 |');
  });

  it('names what is attached for an unknown document, and bounds the page', async () => {
    const { doc, read } = setup();
    expect((await read({ document: 'Nope' })).error).toMatch(/Unknown document: Nope\. Attached: Fixture Paper \([0-9a-f]{12}\)\./);
    expect((await read({ document: documentId(doc), page: 9 })).error).toMatch(/out of range.*4 pages/);
    expect((await read({ document: documentId(doc) }, [])).error).toBe(NO_DOCUMENTS);
  });
});
