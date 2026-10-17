/**
 * read_file's "already read" memory is the calling agent's attended history, not
 * a map the tool keeps. The scope is the caller chain, which is the right scope
 * because a nesting tool forks the child from the caller's branch: what the
 * caller received is already in the child's KV. An agent whose call never
 * attended reads again; outside a pool there is nothing to remember against.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import { CallingAgent, Agent } from '@lloyal-labs/lloyal-agents';
import type { FormatConfig, ToolContext, ToolHistoryEntry } from '@lloyal-labs/lloyal-agents';
import { ReadFileTool } from '../src/tools/read-file';

const FILE = { name: 'notes.md', content: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') };

/** A read_file call whose result is attended, as book() records it. */
const attended = (filename: string, startLine: number, endLine: number): ToolHistoryEntry =>
  ({ name: 'read_file', args: JSON.stringify({ filename, startLine, endLine }), resultCells: 10, contextAfterPercent: 90, timestamp: 0, outcome: 'toolResult' }) as ToolHistoryEntry;

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

type Out = { file?: string; lines?: string[]; note?: string; content?: string };
const read = (tool: ReadFileTool, args: { filename: string; startLine?: number; endLine?: number }, agent?: Agent) =>
  run(function* () {
    if (agent) yield* CallingAgent.set(agent);
    return (yield* tool.execute(args, { attachments: [] } as unknown as ToolContext)) as Out;
  });

describe('read_file — offset reads', () => {
  const longFile = {
    name: 'long.md',
    content: Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n'),
  };

  it('starts the default window at the requested offset, including beyond line 100', async () => {
    const result = await read(new ReadFileTool([longFile]), { filename: 'long.md', startLine: 112 });
    expect(result.lines).toEqual(['112-211']);
    expect(result.content).toBe(longFile.content.split('\n').slice(111, 211).join('\n'));
  });

  it('clips an offset window at the end of the file', async () => {
    const result = await read(new ReadFileTool([longFile]), { filename: 'long.md', startLine: 230 });
    expect(result.lines).toEqual(['230-250']);
    expect(result.content).toBe(longFile.content.split('\n').slice(229).join('\n'));
  });

  it('uses the same default window when subtracting a previously attended offset read', async () => {
    const previous = {
      ...attended('long.md', 112, 211),
      args: JSON.stringify({ filename: 'long.md', startLine: 112 }),
    };
    const result = await read(
      new ReadFileTool([longFile]),
      { filename: 'long.md', startLine: 205, endLine: 220 },
      agentAt(1, [previous]),
    );
    expect(result.lines).toEqual(['212-220']);
    expect(result.content).toBe(longFile.content.split('\n').slice(211, 220).join('\n'));
  });
});

describe('read_file — what this agent has received', () => {
  it('returns only the unread part of an overlapping range, from the agent\'s own attended calls', async () => {
    const tool = new ReadFileTool([FILE]);
    const a = agentAt(1, [attended('notes.md', 1, 20)]);
    const r = await read(tool, { filename: 'notes.md', startLine: 10, endLine: 30 }, a);
    expect(r.lines).toEqual(['21-30']);
    expect(r.content).toContain('line 21');
    expect(r.content).not.toContain('line 15');
  });

  it('another agent with no such history reads the whole range', async () => {
    const tool = new ReadFileTool([FILE]);
    await read(tool, { filename: 'notes.md', startLine: 1, endLine: 20 }, agentAt(1, [attended('notes.md', 1, 20)]));
    const r = await read(tool, { filename: 'notes.md', startLine: 1, endLine: 20 }, agentAt(2));
    expect(r.lines).toEqual(['1-20']);
  });

  it('a forked child does not re-read what its parent already received', async () => {
    const tool = new ReadFileTool([FILE]);
    const parent = agentAt(1, [attended('notes.md', 1, 20)]);
    const child = agentAt(2, [], parent);
    const r = await read(tool, { filename: 'notes.md', startLine: 1, endLine: 25 }, child);
    expect(r.lines).toEqual(['21-25']);
  });

  it('a call whose result never reached the KV leaves nothing to subtract; outside a pool nothing is remembered', async () => {
    const tool = new ReadFileTool([FILE]);
    // The agent asked before, but that call was replaced by a settle nudge: not attended.
    const nudged = { ...attended('notes.md', 1, 20), outcome: 'nudge' } as ToolHistoryEntry;
    const r = await read(tool, { filename: 'notes.md', startLine: 1, endLine: 20 }, agentAt(1, [nudged]));
    expect(r.lines).toEqual(['1-20']);
    const first = await read(tool, { filename: 'notes.md', startLine: 1, endLine: 5 });
    const second = await read(tool, { filename: 'notes.md', startLine: 1, endLine: 5 });
    expect(first.lines).toEqual(['1-5']);
    expect(second.lines).toEqual(['1-5']);
  });
});
