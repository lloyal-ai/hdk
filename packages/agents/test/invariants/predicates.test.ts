/**
 * I43 (received-is-landed) as a unit — the predicate itself, over constructed
 * lineages. `attendedResults` is lineage-aware (self + ancestors), so the
 * invariant must reason over the lineage, not one agent's own history: a child
 * that lands a tool its ancestor also landed is NOT a violation, and a nudge
 * that leaks into `attendedResults` IS.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import { Agent } from '../../src/Agent';
import type { FormatConfig, ToolHistoryEntry } from '../../src/Agent';
import type { PoolRun } from './harness';
import { I43_receivedIsLanded } from './predicates';

const entry = (name: string, args: object, outcome: 'toolResult' | 'nudge' | 'recovery' = 'toolResult'): ToolHistoryEntry =>
  ({ name, args: JSON.stringify(args), resultCells: 0, contextAfterPercent: 100, timestamp: 0, outcome });

function agentAt(id: number, history: ToolHistoryEntry[] = [], parent: Agent | null = null): Agent {
  const a = new Agent({ id, parentId: parent?.id ?? 0, branch: { handle: id } as never, fmt: {} as FormatConfig, parent });
  for (const h of history) a.recordToolResult(h);
  return a;
}

/** A minimal PoolRun — I43 reads only `result.agents[].agent`. */
const runOf = (...agents: Agent[]): PoolRun =>
  ({ result: { agents: agents.map((a) => ({ agent: a, agentId: a.id })) } } as unknown as PoolRun);

describe('I43 received-is-landed', () => {
  it('holds across a lineage — a child sharing a landed tool with its parent is not a violation', () => {
    const parent = agentAt(1, [entry('search', { q: 'a' })]);
    const child = agentAt(2, [entry('search', { q: 'b' })], parent);
    // child.attendedResults('search') sees BOTH (self + parent); a self-only
    // count would read 1 against an attended 2 and falsely fail.
    expect(I43_receivedIsLanded(runOf(parent, child)).ok).toBe(true);
  });

  it('checks a tool only an ANCESTOR landed (never in the child\'s own history)', () => {
    const parent = agentAt(1, [entry('read_file', { f: 'x' })]);
    const child = agentAt(2, [], parent);
    expect(I43_receivedIsLanded(runOf(parent, child)).ok).toBe(true);
  });

  it('passes with the real, outcome-filtered attendedResults when a call was only nudged', () => {
    const a = agentAt(1, [entry('fetch_page', { url: 'u' }, 'nudge')]);
    expect(a.attendedResults('fetch_page')).toEqual([]);
    expect(I43_receivedIsLanded(runOf(a)).ok).toBe(true);
  });

  it('CATCHES a nudge leaking into attendedResults — the regression it guards', () => {
    // A stub whose attendedResults reports a call that only NUDGED (no landed
    // twin): exactly what a broken outcome filter would do.
    const broken = {
      id: 9,
      walkAncestors: (fn: (a: Agent) => readonly ToolHistoryEntry[]) =>
        fn({ toolHistory: [entry('fetch_page', { url: 'u' }, 'nudge')] } as unknown as Agent),
      attendedResults: () => [{ url: 'u' }],
    } as unknown as Agent;
    expect(I43_receivedIsLanded(runOf(broken)).ok).toBe(false);
  });
});
