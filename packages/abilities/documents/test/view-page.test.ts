import { describe, it, expect, vi } from 'vitest';
import { run } from 'effection';
import { TOOL_ATTACHMENTS_KEY } from '@lloyal-labs/lloyal-agents';
import type { ToolContext } from '@lloyal-labs/lloyal-agents';
import type { Attachment } from '@lloyal-labs/media';
import { documentIndexer, documentId } from '../src/documents-index';
import { ViewPageTool, projectable } from '../src/tools/view-page';
import { makeFixture, wordTokenize } from './helpers/fixture';

type View = Record<string, unknown> & { note?: string; error?: string; cite?: string; caption?: string };

function setup() {
  const fx = makeFixture();
  const tool = new ViewPageTool(documentIndexer(fx.store, wordTokenize));
  const view = (args: { document: string; page: number; figure?: number }, attachments: readonly Attachment[] = [fx.doc], agentId = 1) =>
    run(function* () { return (yield* tool.execute(args, { agentId, attachments } as ToolContext)) as View; });
  return { ...fx, view };
}

describe('view_page', () => {
  it('returns the page root as a descriptor under the attachment key, reading no blob for it', async () => {
    const { doc, renders, store, view } = setup();
    // The first call builds the index (which reads the sidecar and markdown).
    const text = await view({ document: documentId(doc), page: 3 });
    expect(text.note).toMatch(/text only/);
    const reads = vi.spyOn(store, 'get');
    const r = await view({ document: documentId(doc), page: 2 });
    expect(r[TOOL_ATTACHMENTS_KEY]).toEqual([renders[2]]);
    expect(r.cite).toBe(`attachment://${documentId(doc)}/page/2`);
    expect(r).toMatchObject({ document: 'Fixture Paper', id: documentId(doc), page: 2 });
    expect(reads).not.toHaveBeenCalled();
  });

  it('a figure returns its own root and caption; a figure that is not there is named', async () => {
    const { doc, figure, view } = setup();
    const r = await view({ document: documentId(doc), page: 2, figure: 1 });
    expect(r[TOOL_ATTACHMENTS_KEY]).toEqual([figure]);
    expect(r.caption).toBe('Figure 1. Cells per configuration.');
    expect(r.cite).toBe(`attachment://${documentId(doc)}/page/2`);
    expect((await view({ document: documentId(doc), page: 2, figure: 2 })).error).toMatch(/1 figure\(s\); figure must be between 1 and 1/);
    expect((await view({ document: documentId(doc), page: 3, figure: 1 })).error).toMatch(/no figures/);
  });

  it('a text-only page says so and carries no media key', async () => {
    const { doc, view } = setup();
    const r = await view({ document: documentId(doc), page: 3 });
    expect(r.note).toMatch(/text only/);
    expect(TOOL_ATTACHMENTS_KEY in r).toBe(false);
  });

  it('a page past the render bound is "not archived" — no range is ever named', async () => {
    const { doc, view } = setup();
    const r = await view({ document: documentId(doc), page: 4 });
    expect(r.note).toMatch(/not archived/);
    expect(r.note).not.toMatch(/\d+\s*[–-]\s*\d+/);
    expect(TOOL_ATTACHMENTS_KEY in r).toBe(false);
  });

  it('page one is always projectable; a repeat by the same agent carries the page again with a note — admission is the only gate', async () => {
    const { doc, renders, view } = setup();
    expect((await view({ document: documentId(doc), page: 1 }))[TOOL_ATTACHMENTS_KEY]).toEqual([renders[1]]);
    // A settle rejection can replace the first result with a nudge; the tool
    // cannot see that, so a repeat must still put the page in front of the model.
    const again = await view({ document: documentId(doc), page: 1 });
    expect(again[TOOL_ATTACHMENTS_KEY]).toEqual([renders[1]]);
    expect(again.note).toMatch(/viewed page 1 before/);
    expect((await view({ document: documentId(doc), page: 1 }, [doc], 2))[TOOL_ATTACHMENTS_KEY]).toEqual([renders[1]]);
    expect((await view({ document: documentId(doc), page: 5 })).error).toMatch(/out of range/);
  });

  it('the projection rule is a rule over the sidecar facts', () => {
    const base = { page: 2, startLine: 1, endLine: 1, chars: 10, imageObjects: 0, pathObjects: 0, taggedTables: 0, taggedFigures: 0 };
    expect(projectable(base)).toBe(false);
    expect(projectable({ ...base, page: 1 })).toBe(true);
    expect(projectable({ ...base, chars: 0 })).toBe(true);
    expect(projectable({ ...base, imageObjects: 1 })).toBe(true);
    expect(projectable({ ...base, pathObjects: 20 })).toBe(true);
    expect(projectable({ ...base, pathObjects: 19 })).toBe(false);
    expect(projectable({ ...base, taggedTables: 1 })).toBe(true);
    expect(projectable({ ...base, taggedFigures: 1 })).toBe(true);
  });
});
