/**
 * I43 (attended-is-admitted) as a unit — the predicate over constructed
 * lineages AND the trace the pool would have written. The oracle is the
 * trace's admission record (`tool:settle_order`, kind `toolResult`), resolved
 * to a tool by the preceding `tool:dispatch`; the ledger under test is
 * `attendedResults`. Lineage is walked on both sides and closed over heals.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import { Agent } from '../../src/Agent';
import type { FormatConfig, ToolHistoryEntry } from '../../src/Agent';
import type { PoolRun } from './harness';
import { I43_attendedIsAdmitted } from './predicates';

const entry = (name: string, args: object, outcome: 'toolResult' | 'nudge' | 'recovery' = 'toolResult'): ToolHistoryEntry =>
  ({ name, args: JSON.stringify(args), resultCells: 0, contextAfterPercent: 100, timestamp: 0, outcome });

function agentAt(id: number, history: ToolHistoryEntry[] = [], parent: Agent | null = null): Agent {
  const a = new Agent({ id, parentId: parent?.id ?? 0, branch: { handle: id } as never, fmt: {} as FormatConfig, parent });
  for (const h of history) a.recordToolResult(h);
  return a;
}

// The trace, as the pool writes it.
const dispatch = (agentId: number, callId: string, tool: string) => ({ type: 'tool:dispatch', agentId, callId, tool });
const settled = (...batch: Array<{ agentId: number; callId: string; kind: 'toolResult' | 'nudge' | 'recovery' }>) => ({ type: 'tool:settle_order', batch });
const heal = (of: number, agentId: number) => ({ type: 'pool:agentHeal', of, agentId });

/** A minimal PoolRun — I43 reads `result.agents[].agent` and `traceEvents`. */
const runOf = (agents: Agent[], traceEvents: object[]): PoolRun =>
  ({ result: { agents: agents.map((a) => ({ agent: a, agentId: a.id })) }, traceEvents } as unknown as PoolRun);

describe('I43 attended-is-admitted', () => {
  it('holds across a lineage — a child sharing an attended tool with its parent is not a violation', () => {
    const parent = agentAt(1, [entry('search', { q: 'a' })]);
    const child = agentAt(2, [entry('search', { q: 'b' })], parent);
    const trace = [
      dispatch(1, 'c1', 'search'), settled({ agentId: 1, callId: 'c1', kind: 'toolResult' }),
      dispatch(2, 'c2', 'search'), settled({ agentId: 2, callId: 'c2', kind: 'toolResult' }),
    ];
    // child.attendedResults('search') sees BOTH (self + parent), and so does the lineage's admission count.
    expect(I43_attendedIsAdmitted(runOf([parent, child], trace)).ok).toBe(true);
  });

  it("checks a tool only an ANCESTOR attended (never in the child's own history)", () => {
    const parent = agentAt(1, [entry('read_file', { f: 'x' })]);
    const child = agentAt(2, [], parent);
    const trace = [dispatch(1, 'c1', 'read_file'), settled({ agentId: 1, callId: 'c1', kind: 'toolResult' })];
    expect(I43_attendedIsAdmitted(runOf([parent, child], trace)).ok).toBe(true);
  });

  it('a nudge is admitted but not attended: a guard nudge (no dispatch) and a settle-reject nudge (a dispatch) both count for nothing', () => {
    const a = agentAt(1, [entry('fetch_page', { url: 'u' }, 'nudge'), entry('web_search', { q: 'x' }, 'nudge')]);
    const trace = [
      settled({ agentId: 1, callId: 'c1', kind: 'nudge' }),
      dispatch(1, 'c2', 'web_search'), settled({ agentId: 1, callId: 'c2', kind: 'nudge' }),
    ];
    expect(a.attendedResults('fetch_page')).toEqual([]);
    expect(I43_attendedIsAdmitted(runOf([a], trace)).ok).toBe(true);
  });

  it('closes over a heal: the replacement carries the original\'s entries, announced under the original\'s id — counted once', () => {
    const original = agentAt(1, [entry('look', { d: 'x' })]);
    const replacement = agentAt(3, [entry('look', { d: 'x' })]);   // the replayed ledger, its own parent null
    const trace = [
      dispatch(1, 'c1', 'look'), settled({ agentId: 1, callId: 'c1', kind: 'toolResult' }),
      heal(1, 3),
    ];
    expect(I43_attendedIsAdmitted(runOf([original, replacement], trace)).ok).toBe(true);
  });

  it('a retry re-dispatches the same call: one admission, one attended entry', () => {
    const a = agentAt(1, [entry('flaky', { q: 'x' })]);
    const trace = [dispatch(1, 'c1', 'flaky'), dispatch(1, 'c1', 'flaky'), settled({ agentId: 1, callId: 'c1', kind: 'toolResult' })];
    expect(I43_attendedIsAdmitted(runOf([a], trace)).ok).toBe(true);
  });

  it('CATCHES a mis-booked outcome: the pool admitted a nudge, the ledger says a result', () => {
    // The oracle is the trace, so a ledger that books `toolResult` for a call
    // the pool announced as `nudge` fails — the regression this guards.
    const a = agentAt(1, [entry('web_search', { q: 'x' }, 'toolResult')]);
    const trace = [dispatch(1, 'c1', 'web_search'), settled({ agentId: 1, callId: 'c1', kind: 'nudge' })];
    expect(I43_attendedIsAdmitted(runOf([a], trace)).ok).toBe(false);
  });

  it('CATCHES a leak: the pool admitted only a nudge, and attendedResults reports it as received', () => {
    // A stub whose attendedResults reports a call the pool announced as a
    // nudge — exactly what a broken outcome filter would do.
    const leaking = {
      id: 9,
      walkAncestors: (fn: (a: Agent) => readonly unknown[]) =>
        fn({ id: 9, toolHistory: [entry('fetch_page', { url: 'u' }, 'nudge')] } as unknown as Agent),
      attendedResults: () => [{ url: 'u' }],
    } as unknown as Agent;
    expect(I43_attendedIsAdmitted(runOf([leaking], [settled({ agentId: 9, callId: 'c1', kind: 'nudge' })])).ok).toBe(false);
  });

  it('CATCHES an admission with no dispatch behind it', () => {
    const a = agentAt(1, [entry('t', {})]);
    expect(I43_attendedIsAdmitted(runOf([a], [settled({ agentId: 1, callId: 'c1', kind: 'toolResult' })])).ok).toBe(false);
  });
});
