import { describe, it, expect, vi } from 'vitest';
import { run } from 'effection';
import { TOOL_ATTACHMENTS_KEY, CallingAgent, Agent } from '@lloyal-labs/lloyal-agents';
import type { FormatConfig, ToolContext, ToolHistoryEntry } from '@lloyal-labs/lloyal-agents';
import type { Attachment } from '@lloyal-labs/media';
import { documentIndexer, documentId } from '../src/documents-index';
import { ViewPageTool, projectable } from '../src/tools/view-page';
import { makeFixture, wordTokenize } from './helpers/fixture';

type View = Record<string, unknown> & { note?: string; error?: string; cite?: string; caption?: string };

/** What the POOL books once the page has been prefilled onto the branch. Never the tool. */
const bookedView = (document: string, page: number, outcome: 'toolResult' | 'nudge' = 'toolResult'): ToolHistoryEntry =>
  ({ name: 'view_page', args: JSON.stringify({ document, page }), resultCells: 1629, contextAfterPercent: 80, timestamp: 0, outcome }) as ToolHistoryEntry;

/** A real {@link Agent} with a cast branch, exactly as the agents suite builds
 *  one (`Agent.test.ts:213`, `scheduler.test.ts:25`). Real and not a stub,
 *  because the lineage these tests are about is `Agent.walkAncestors`; a
 *  hand-rolled walk would prove the test's own loop instead. Only `id`,
 *  `parent` and the booked history are read here, so the branch and format
 *  never have to exist. History is booked through `recordToolResult`, the
 *  method the pool itself calls once a result has been prefilled. */
function agentAt(id: number, history: ToolHistoryEntry[] = [], parent: Agent | null = null): Agent {
  const a = new Agent({ id, parentId: parent?.id ?? 0, branch: { handle: id } as never, fmt: {} as FormatConfig, parent });
  for (const h of history) a.recordToolResult(h);
  return a;
}

function setup() {
  const fx = makeFixture();
  const tool = new ViewPageTool(documentIndexer(fx.store, wordTokenize));
  const view = (args: { document: string; page: number; figure?: number }, attachments: readonly Attachment[] = [fx.doc], agent?: Agent) =>
    run(function* () {
      if (agent) yield* CallingAgent.set(agent);
      return (yield* tool.execute(args, { attachments } as unknown as ToolContext)) as View;
    });
  return { ...fx, tool, view };
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

  it('page one is always projectable; a repeat carries the page AGAIN with a note — admission is the only gate', async () => {
    const { doc, renders, view } = setup();
    const agent = agentAt(1);
    expect((await view({ document: documentId(doc), page: 1 }, [doc], agent))[TOOL_ATTACHMENTS_KEY]).toEqual([renders[1]]);
    // Nothing is remembered until the page LANDS; the pool books it here.
    agent.recordToolResult(bookedView(documentId(doc), 1));

    // A settle rejection can replace a result with a nudge, and the tool cannot
    // see that, so a repeat must still put the page in front of the model.
    const again = await view({ document: documentId(doc), page: 1 }, [doc], agent);
    expect(again[TOOL_ATTACHMENTS_KEY]).toEqual([renders[1]]);
    expect(again.note).toMatch(/viewed page 1 before/);

    expect((await view({ document: documentId(doc), page: 1 }, [doc], agentAt(2)))[TOOL_ATTACHMENTS_KEY]).toEqual([renders[1]]);
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

describe('view_page — the note follows admission, not the tool\'s memory', () => {
  it('an attended view earns the note on repeat; a nudged view does not; the page comes back either way', async () => {
    const { doc, renders, view } = setup();
    const viewAs = (agent: Agent) => view({ document: documentId(doc), page: 1 }, [doc], agent);
    const seen = await viewAs(agentAt(1, [bookedView(documentId(doc), 1)]));
    expect(seen[TOOL_ATTACHMENTS_KEY]).toEqual([renders[1]]);
    expect(seen.note).toMatch(/viewed page 1 before/);
    const unseen = await viewAs(agentAt(2, [bookedView(documentId(doc), 1, 'nudge')]));
    expect(unseen[TOOL_ATTACHMENTS_KEY]).toEqual([renders[1]]);
    expect(unseen.note).toBeUndefined();
  });
});

