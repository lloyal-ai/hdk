/**
 * The scheduler is a pure function over one value. Each test hands it a
 * hand-built tick state and reads the decision back — no store, no mock
 * sampling, no event ordering. These are the decision-matrix cells as a table.
 */
import { describe, it, expect } from 'vitest';
import { MockSessionContext } from '../../sdk/src/testing.js';
import { Agent } from '../src/Agent';
import { ContextPressure } from '../src/pressure';
import { DefaultScheduler, type SchedulerOptions } from '../src/scheduler';
import { emptyPending, type TickState, type PrefillItem, type Pending } from '../src/state';
import type { AgentPolicy, PolicyConfig } from '../src/AgentPolicy';
import type { AgentTaskSpec } from '../src/types';
import { createMockBranch } from './helpers/mock-branch';
import { FMT } from './helpers/format-config';

const config: PolicyConfig = { maxTurns: 10, terminalToolName: 'report', hasNonTerminalTools: true };
const ctx = new MockSessionContext({ nCtx: 16384 });

function scheduler(over: Partial<SchedulerOptions> = {}): DefaultScheduler {
  return new DefaultScheduler({ recovery: 'cohort', terminalToolName: 'report', config, ...over }, ctx as never, new Map());
}

function agent(id: number, status: 'active' | 'awaiting_tool' | 'idle' = 'active'): Agent {
  const a = new Agent({ id, parentId: 0, branch: createMockBranch({ handle: id }) as never, fmt: FMT });
  if (status !== 'idle') a.transition('active');
  if (status === 'awaiting_tool') a.transition('awaiting_tool');
  return a;
}

/** A tick state at `remaining` cells with the default thresholds (soft 1024, hard 512). */
function state(agents: Agent[], remaining = 8000, over: Partial<TickState> = {}, pending: Partial<Pending> = {}): TickState {
  return {
    tick: 0, now: 0, wall: 0,
    pressure: new ContextPressure({ nCtx: 16384, cellsUsed: 16384 - remaining, remaining }, { softLimit: 1024, hardLimit: 512 }),
    agents,
    pending: { ...emptyPending(), ...pending },
    signals: { paused: false, windDown: false, cancelled: [], orchestratorDone: false },
    inflight: new Set(),
    ...over,
  };
}

const quiet: AgentPolicy = {
  onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
  shouldExit: () => false,
};

const recoveryItem = (a: Agent, tokens = 3): PrefillItem =>
  ({ kind: 'recovery', rail: 'token', agent: a, tokens: Array(tokens).fill(1), toolName: 'recovery', callId: `recovery:${a.id}`, args: '' });
const resultItem = (a: Agent, tokens: number): PrefillItem =>
  ({ kind: 'toolResult', rail: 'token', agent: a, tokens: Array(tokens).fill(1), toolName: 'web_search', callId: 'c1', args: '{}' });

/** Latch `currentTool` the way the pool does: a partial parse that sees the terminal call. */
function emitting(a: Agent, tool: string): Agent {
  const c = new MockSessionContext({ nCtx: 16384 });
  c.parseChatOutput = () => ({ content: '', reasoningContent: '', toolCalls: [{ name: tool, arguments: '{}', id: 'c' }] });
  a.observe(c as never);
  return a;
}

describe('DefaultScheduler.schedule', () => {
  it('a paused tick holds: only cancels are decided, everything else waits where it is', () => {
    const a = agent(1);
    const st = state([a], 8000, { signals: { paused: true, windDown: false, cancelled: [1], orchestratorDone: false }, inflight: new Set([1]) });
    const S = scheduler().schedule(st, quiet);
    expect(S.hold).toBe(true);
    expect(S.halts).toEqual([a]);
    expect(S.drops).toEqual([{ agent: a, reason: 'user_cancel', done: false, recovery: { type: 'none' } }]);
    expect(S.decode).toEqual([]);
    expect(S.remaining).toBe(st.pending);
  });

  it('pressure is the cause when it and the policy both say stop; a `false` vetoes; abstaining defers to pressure', () => {
    const critical = 100; // remaining < hardLimit
    const says = (exit: boolean | undefined): AgentPolicy => ({ ...quiet, shouldExit: () => exit as boolean });

    let S = scheduler().schedule(state([agent(1)], critical), says(true));
    expect(S.drops[0]).toMatchObject({ reason: 'pressure_critical', exitReason: 'pressure_critical', done: true });

    S = scheduler().schedule(state([agent(1)], 8000), says(true));
    expect(S.drops[0]).toMatchObject({ reason: 'policy_exit', exitReason: 'policy_exit' });

    const vetoed = agent(1);
    S = scheduler().schedule(state([vetoed], critical), says(false));
    expect(S.drops).toEqual([]);
    expect(S.decode).toEqual([vetoed]);

    S = scheduler().schedule(state([agent(1)], critical), { onProduced: quiet.onProduced });
    expect(S.drops[0]).toMatchObject({ reason: 'pressure_critical' });
  });

  it('an agent producing its own report is salvaged, not re-prompted', () => {
    const a = emitting(agent(1), 'report');
    const S = scheduler().schedule(state([a], 100), { ...quiet, shouldExit: () => true });
    expect(S.drops[0].recovery).toEqual({ type: 'salvage' });
  });

  it('the voluntary report cap force-finishes a report at the budget', () => {
    const a = emitting(agent(1), 'report');
    for (let i = 0; i < 4; i++) a.accumulateToken('x');
    const S = scheduler({ recoveryBudget: 4 }).schedule(state([a]), quiet);
    expect(S.drops[0]).toMatchObject({ reason: 'terminal_cap', exitReason: 'terminal_cap', recovery: { type: 'salvage' } });
  });

  it('an extracting agent is exempt from the kill and finishes at its token-stop', () => {
    const a = agent(1);
    a.markExtracting(3);
    let S = scheduler().schedule(state([a], 100), { ...quiet, shouldExit: () => true });
    expect(S.drops).toEqual([]);
    expect(S.decode).toEqual([a]);
    for (let i = 0; i < 3; i++) a.accumulateToken('x');
    S = scheduler().schedule(state([a], 100), { ...quiet, shouldExit: () => true });
    expect(S.finishes).toEqual([a]);
    expect(S.decode).toEqual([]);
  });

  it('serial recovery admits one turn at a time, ungated by headroom', () => {
    const a = agent(1, 'awaiting_tool'); a.markExtracting(Infinity, true);
    const b = agent(2, 'awaiting_tool'); b.markExtracting(Infinity, true);
    // No headroom at all — serial still admits, because the report owns the freed cells.
    let S = scheduler({ recovery: 'serial' }).schedule(state([a, b], 100, {}, { items: [recoveryItem(a), recoveryItem(b)] }), quiet);
    expect(S.prefills.map(i => i.agent)).toEqual([a]);
    expect(S.remaining.items.map(i => i.agent)).toEqual([b]);

    // One already decoding blocks the next.
    const decoding = agent(3); decoding.markExtracting(Infinity, true);
    S = scheduler({ recovery: 'serial' }).schedule(state([decoding, a], 8000, {}, { items: [recoveryItem(a)] }), quiet);
    expect(S.prefills).toEqual([]);
    expect(S.remaining.items.map(i => i.agent)).toEqual([a]);
  });

  it('a cohort recovery turn reserves prompt + budget against the recovery band; a plain result stays above softLimit', () => {
    const live = agent(9);                       // an active sibling keeps the stall-break out of it
    const r = agent(1, 'awaiting_tool'); r.markExtracting(1000);
    // remaining 1524: headroom 500, band 512 → a recovery item may spend 1012.
    let S = scheduler().schedule(state([live, r], 1524, {}, { items: [recoveryItem(r, 3)] }), quiet);
    expect(S.prefills.map(i => i.agent)).toEqual([r]);          // 3 + 1000 ≤ 1012
    expect(S.pressure.cellsUsed).toBe(state([], 1524).pressure.cellsUsed + 3);  // only the prompt's cells are spent now

    const big = agent(2, 'awaiting_tool'); big.markExtracting(1100);
    S = scheduler().schedule(state([live, big], 1524, {}, { items: [recoveryItem(big, 3)] }), quiet);
    expect(S.prefills).toEqual([]);                             // 3 + 1100 > 1012 → deferred
    expect(S.remaining.items.map(i => i.agent)).toEqual([big]);

    const t = agent(3, 'awaiting_tool');
    S = scheduler().schedule(state([live, t], 1524, {}, { items: [resultItem(t, 600)] }), quiet);
    expect(S.prefills).toEqual([]);                             // 600 > headroom 500
    S = scheduler().schedule(state([live, t], 1524, {}, { items: [resultItem(t, 400)] }), quiet);
    expect(S.prefills.map(i => i.agent)).toEqual([t]);
  });

  it('the stall-break names the hook: pressure_settle_reject with it, settle_stall_break without, a fitting nudge replaces the item', () => {
    const mk = () => { const a = agent(1, 'awaiting_tool'); return a; };
    const oversized = (a: Agent) => state([a], 1524, {}, { items: [resultItem(a, 5000)] });

    let a = mk();
    let S = scheduler().schedule(oversized(a), { ...quiet, onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }) });
    expect(S.stall).toHaveLength(1);
    expect(S.stall[0].nudge).toBeNull();
    expect(S.stall[0].drop?.agent).toBe(a);
    expect(S.stall[0].drop?.reason).toBe('pressure_settle_reject');
    expect(S.stall[0].drop?.done).toBe(true);

    a = mk();
    S = scheduler().schedule(oversized(a), quiet);
    expect(S.stall[0].drop?.reason).toBe('settle_stall_break');

    a = mk();
    S = scheduler().schedule(oversized(a), { ...quiet, onSettleReject: () => ({ type: 'nudge', message: 'report now' }) });
    expect(S.stall[0].nudge?.replacement?.kind).toBe('nudge');
    expect(S.stall[0].drop).toBeNull();
    expect(S.remaining.items).toEqual([S.stall[0].nudge!.replacement]);
  });

  it('wind-down forces the cohort shape and reaps every active agent that is not mid-report', () => {
    const reporting = emitting(agent(1), 'report');
    const researching = agent(2);
    const st = state([reporting, researching], 8000, { signals: { paused: false, windDown: true, cancelled: [], orchestratorDone: true } });
    const S = scheduler({ recovery: 'serial' }).schedule(st, quiet);
    expect(S.mode).toBe('cohort');
    expect(S.drops.map(d => [d.agent.id, d.reason])).toEqual([[2, 'wind_down']]);
    expect(S.decode).toEqual([reporting]);
  });

  it('retries re-dispatch when due and are abandoned on wind-down', () => {
    const a = agent(1, 'awaiting_tool');
    const park = { agent: a, tc: { name: 'web_search', arguments: '{}', id: 'c1' }, callId: 'c1', notBefore: 0, attempt: 1 };
    let S = scheduler().schedule(state([a], 8000, {}, { retries: [park] }), quiet);
    expect(S.dispatch).toEqual([{ agent: a, tc: park.tc, retryAttempt: 1, retryCallId: 'c1' }]);

    S = scheduler().schedule(state([a], 8000, { signals: { paused: false, windDown: true, cancelled: [], orchestratorDone: true } }, { retries: [park] }), quiet);
    expect(S.abandoned).toEqual([park]);
    expect(S.dispatch).toEqual([]);
  });

  it('the close sweep recovers the first idle agent without a result that was never discarded, then closes', () => {
    const reported = agent(1, 'idle'); reported.setResult('r', 'voluntary_return');
    const discarded = agent(2, 'idle'); discarded.failed = 'user_cancel';
    const clean = agent(3, 'idle');
    const done = { paused: false, windDown: false, cancelled: [], orchestratorDone: true };
    const withRecovery: AgentPolicy = { ...quiet, onRecovery: () => ({ type: 'extract', prompt: { system: 's', user: 'u' } }) };

    let S = scheduler().schedule(state([reported, discarded, clean], 8000, { signals: done }), withRecovery);
    expect(S.sweep?.agent).toBe(clean);
    expect(S.sweep?.recovery).toMatchObject({ type: 'extract', serial: true, budget: Infinity });
    expect(S.close).toBe(false);

    S = scheduler().schedule(state([reported, discarded], 8000, { signals: done }), withRecovery);
    expect(S.sweep).toBeNull();
    expect(S.close).toBe(true);
  });

  it('cells admitted this tick lower the pressure the verdicts read', () => {
    const seen: number[] = [];
    const spy: AgentPolicy = { ...quiet, shouldExit: (_a, p) => { seen.push(p.cellsUsed); return false; } };
    const a = agent(1);
    const task: AgentTaskSpec = { systemPrompt: 's', content: 'c' };
    const req = { agent: agent(2, 'idle'), suffixTokens: Array(100).fill(1), formattedPrompt: '', task, resolve: () => {}, reject: () => {}, discarded: false };
    const st = state([a], 8000, {}, { spawns: [req] });
    const S = scheduler().schedule(st, spy);
    expect(S.spawns).toEqual([req]);
    expect(seen).toEqual([st.pressure.cellsUsed + 100]);
    expect(S.pressure.cellsUsed).toBe(st.pressure.cellsUsed + 100);
  });

  it('an agent cancelled this schedule gets nothing else from it: no admission, no retry, no dispatch', () => {
    const a = agent(7, 'awaiting_tool');
    const tc = { name: 'web_search', arguments: '{}', id: 'x' };
    const cancelled = { paused: false, windDown: false, cancelled: [7], orchestratorDone: false };
    const S = scheduler().schedule(
      state([a], 8000, { signals: cancelled }, {
        items: [resultItem(a, 3)],
        retries: [{ agent: a, tc, callId: 'r1', notBefore: 0, attempt: 1 }],
        dispatches: [{ agent: a, tc }],
      }),
      quiet,
    );
    expect(S.drops.map(d => [d.agent.id, d.reason])).toEqual([[7, 'user_cancel']]);
    expect(S.prefills).toEqual([]);
    expect(S.dispatch).toEqual([]);
    // Dropped, not carried: the agent is gone, so is its work.
    expect(S.remaining.items).toEqual([]);
    expect(S.remaining.retries).toEqual([]);
  });

  it('an extend larger than headroom is carried, not admitted', () => {
    const a = agent(1);
    const req = { tokens: Array(9000).fill(1), userContent: 'u', assistantContent: 'a', resolve: () => {}, reject: () => {}, discarded: false };
    const S = scheduler().schedule(state([a], 8000, {}, { extends: [req] }), quiet);
    expect(S.extends).toEqual([]);
    expect(S.remaining.extends).toEqual([req]);
    expect(S.decode).toEqual([a]);
  });

  it('an extend that can never fit — nothing decoding, nothing re-activating — is rejected, not parked forever', () => {
    const req = { tokens: Array(9000).fill(1), userContent: 'u', assistantContent: 'a', resolve: () => {}, reject: () => {}, discarded: false };
    const S = scheduler().schedule(state([], 8000, {}, { extends: [req] }), quiet);
    expect(S.extends).toEqual([]);
    expect(S.remaining.extends).toEqual([]);
    expect(S.rejectedExtends).toEqual([req]);
  });

  it('queued work belongs to an agent still awaiting it: a cancelled owner from an earlier tick gets no dispatch, no retry, no item', () => {
    // The hold path returns pending untouched while the cancel is enacted, so
    // on resume the owner reads idle + failed and this schedule's drop set is
    // empty. Status is the durable truth; the tick set covers only its own tick.
    const a = agent(9, 'awaiting_tool');
    a.transition('idle'); a.failed = 'user_cancel'; a.pruneRequested = true;
    const tc = { name: 'web_search', arguments: '{}', id: 'x' };
    const S = scheduler().schedule(
      state([a], 8000, {}, {
        dispatches: [{ agent: a, tc }],
        retries: [{ agent: a, tc, callId: 'r1', notBefore: 0, attempt: 1 }],
        items: [resultItem(a, 3)],
      }),
      quiet,
    );
    expect(S.dispatch).toEqual([]);
    expect(S.prefills).toEqual([]);
    expect(S.remaining.dispatches).toEqual([]);
    expect(S.remaining.retries).toEqual([]);
    expect(S.remaining.items).toEqual([]);
  });

  it('a parked retry is due against the tick\'s sampled wall clock, not the ambient one', () => {
    // The schedule is a function of its input: the same state decides the
    // same way whenever it runs. Parks are wall-time (a rate-limit window keeps
    // running through a pause), so the wall is sampled into the tick with the
    // pressure, one reading per tick.
    const a = agent(1, 'awaiting_tool');
    const park = { agent: a, tc: { name: 'web_search', arguments: '{}', id: 'c1' }, callId: 'c1', notBefore: 10, attempt: 1 };
    let S = scheduler().schedule(state([a], 8000, { wall: 5 }, { retries: [park] }), quiet);
    expect(S.dispatch).toEqual([]);
    expect(S.remaining.retries).toEqual([park]);
    S = scheduler().schedule(state([a], 8000, { wall: 10 }, { retries: [park] }), quiet);
    expect(S.dispatch).toEqual([{ agent: a, tc: park.tc, retryAttempt: 1, retryCallId: 'c1' }]);
  });
});
