/**
 * read_document: the text it returns, and what it declines to return twice.
 *
 * The tool keeps no memory. What counts as already-read is the calling agent's
 * BOOKED history, which the pool writes only after a result lands — so these
 * tests book what the pool would book rather than relying on the tool having
 * recorded anything itself.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import { CallingAgent, Agent } from '@lloyal-labs/lloyal-agents';
import type { FormatConfig, ToolContext, ToolHistoryEntry } from '@lloyal-labs/lloyal-agents';
import type { Attachment } from '@lloyal-labs/media';
import { documentIndexer, documentId, NO_DOCUMENTS } from '../src/documents-index';
import { ReadDocumentTool } from '../src/tools/read-document';
import { makeFixture, wordTokenize } from './helpers/fixture';

type Read = { document?: string; id?: string; lines?: string[]; pageStart?: number; pageEnd?: number; cite?: string; content?: string; note?: string; error?: string };

/** What the POOL books once a result lands on the branch. Never the tool. */
const booked = (args: Record<string, unknown>, outcome: 'toolResult' | 'nudge' = 'toolResult'): ToolHistoryEntry =>
  ({ name: 'read_document', args: JSON.stringify(args), resultCells: 10, contextAfterPercent: 90, timestamp: 0, outcome }) as ToolHistoryEntry;

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
  const tool = new ReadDocumentTool(documentIndexer(fx.store, wordTokenize));
  const read = (
    args: { document: string; page?: number; startLine?: number; endLine?: number },
    attachments: readonly Attachment[] = [fx.doc],
    agent?: Agent,
  ) =>
    run(function* () {
      if (agent) yield* CallingAgent.set(agent);
      return (yield* tool.execute(args, { attachments } as unknown as ToolContext)) as Read;
    });
  return { ...fx, tool, read };
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
    const byTitle = await read({ document: 'fixture paper', startLine: 3, endLine: 5 });
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

  it('names what is attached for an unknown document, and bounds the page', async () => {
    const { doc, read } = setup();
    expect((await read({ document: 'Nope' })).error).toMatch(/Unknown document: Nope\. Attached: Fixture Paper \([0-9a-f]{12}\)\./);
    expect((await read({ document: documentId(doc), page: 9 })).error).toMatch(/out of range.*4 pages/);
    expect((await read({ document: documentId(doc) }, [])).error).toBe(NO_DOCUMENTS);
  });
});

describe('read_document — the agent\'s attended history is the memory', () => {
  it('a re-read of what this agent RECEIVED is a note; another agent reads it fresh', async () => {
    const { doc, read } = setup();
    const agent = agentAt(1);
    const first = await read({ document: documentId(doc), page: 2 }, [doc], agent);
    expect(first.lines).toEqual(['7-12']);
    // Nothing is remembered until the result LANDS. The pool books it here.
    agent.recordToolResult(booked({ document: documentId(doc), page: 2 }));

    const again = await read({ document: documentId(doc), page: 2 }, [doc], agent);
    expect(again.note).toMatch(/already read/);
    expect(again.content).toBeUndefined();

    const other = await read({ document: documentId(doc), page: 2 }, [doc], agentAt(7));
    expect(other.content).toContain('| baseline | 803 |');
  });

  it('a forked child skips what its parent received; a call the pool rejected counts for nothing', async () => {
    const { doc, read } = setup();
    const parent = agentAt(1, [booked({ document: documentId(doc), startLine: 1, endLine: 6 })]);
    const child = agentAt(2, [], parent);
    expect((await read({ document: documentId(doc), startLine: 1, endLine: 10 }, [doc], child)).lines).toEqual(['7-10']);

    const nudged = agentAt(3, [booked({ document: documentId(doc), startLine: 1, endLine: 6 }, 'nudge')]);
    expect((await read({ document: documentId(doc), startLine: 1, endLine: 6 }, [doc], nudged)).lines).toEqual(['1-6']);
  });

  it('a page already read is subtracted from a later line range — which only the document\'s own map can resolve', async () => {
    // The pool books the model's RAW arguments, so an attended `{ page: 2 }` call
    // carries no line numbers at all. Turning it into lines 7–12 needs this
    // document's section map. No amount of range arithmetic over the history
    // can do it: an implementation that only subtracts numbers it finds in
    // `args` returns the whole span, and this test fails.
    const { doc, read } = setup();
    const seenPage2 = agentAt(9, [booked({ document: documentId(doc), page: 2 })]);
    const r = await read({ document: documentId(doc), startLine: 7, endLine: 16 }, [doc], seenPage2);
    expect(r.lines).toEqual(['13-16']);
    expect(r.content).toContain('Discussion');
    expect(r.content).not.toContain('baseline');
  });
});
