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
import type { AgentPolicy } from '../src/AgentPolicy';
import { makeFrame } from '../src/hooks';
import type { AgentTaskSpec } from '../src/types';
import { createMockBranch } from './helpers/mock-branch';
import { FMT } from './helpers/format-config';

const ctx = new MockSessionContext({ nCtx: 16384 });
/** The frame with nothing protected: its gate never fires, its defaults stand. */
const frame = makeFrame({ protectedTools: new Set(), grants: new Set() });

function scheduler(over: Partial<SchedulerOptions> = {}): DefaultScheduler {
  return new DefaultScheduler({ recovery: 'cohort', terminalToolName: 'report', ...over }, ctx as never, new Map(), frame);
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

  it('an extracting agent is exempt from the kill: never dropped, finished at its token-stop or when the pressure is critical', () => {
    const a = agent(1);
    a.markExtracting(3);
    // Room above the reserve, budget left, a policy that wants it gone: it decodes.
    let S = scheduler().schedule(state([a], 2000), { ...quiet, shouldExit: () => true });
    expect(S.drops).toEqual([]);
    expect(S.decode).toEqual([a]);
    // Budget spent: finished.
    for (let i = 0; i < 3; i++) a.accumulateToken('x');
    S = scheduler().schedule(state([a], 2000), { ...quiet, shouldExit: () => true });
    expect(S.finishes).toEqual([a]);
    expect(S.decode).toEqual([]);
    // Below the reserve with budget left: finished, still never dropped.
    const b = agent(2); b.markExtracting(1000);
    S = scheduler().schedule(state([b], 100), { ...quiet, shouldExit: () => true });
    expect(S.drops).toEqual([]);
    expect(S.finishes).toEqual([b]);
  });

  it('serial recovery admits one turn at a time, exempt from the soft reserve', () => {
    const a = agent(1, 'awaiting_tool'); a.markExtracting(Infinity, true);
    const b = agent(2, 'awaiting_tool'); b.markExtracting(Infinity, true);
    // No headroom at all (600 < softLimit) — serial still admits, because the report owns the freed cells.
    let S = scheduler({ recovery: 'serial' }).schedule(state([a, b], 600, {}, { items: [recoveryItem(a), recoveryItem(b)] }), quiet);
    expect(S.prefills.map(i => i.agent)).toEqual([a]);
    expect(S.remaining.items.map(i => i.agent)).toEqual([b]);

    // One already decoding blocks the next.
    const decoding = agent(3); decoding.markExtracting(Infinity, true);
    S = scheduler({ recovery: 'serial' }).schedule(state([decoding, a], 8000, {}, { items: [recoveryItem(a)] }), quiet);
    expect(S.prefills).toEqual([]);
    expect(S.remaining.items.map(i => i.agent)).toEqual([a]);
  });

  it('serial recovery is exempt from the soft reserve, not from the hard one: it fits what physically remains after earlier admissions', () => {
    const withRecovery: AgentPolicy = { ...quiet, onRecovery: () => ({ type: 'extract', prompt: { system: 's', user: 'u' } }) };
    const serial = () => scheduler({ recovery: 'serial' });
    // remaining 1000, hardLimit 512: a serial prompt may take 488 cells.
    const a = agent(1, 'awaiting_tool'); a.markExtracting(Infinity, true);
    let S = serial().schedule(state([a], 1000, {}, { items: [recoveryItem(a, 400)] }), withRecovery);
    expect(S.prefills.map(i => i.agent)).toEqual([a]);
    expect(S.pressure.cellsUsed).toBe(state([], 1000).pressure.cellsUsed + 400);

    // Earlier admissions count: at remaining 2000 a 300-cell spawn leaves 1188 for the prompt,
    // and the spawn re-activating keeps the stall-break out of it.
    const task: AgentTaskSpec = { systemPrompt: 's', content: 'c' };
    const req = { agent: agent(9, 'idle'), suffixTokens: Array(300).fill(1), formattedPrompt: '', task, resolve: () => {}, reject: () => {}, discarded: false };
    S = serial().schedule(state([a], 2000, {}, { spawns: [req], items: [recoveryItem(a, 1200)] }), withRecovery);
    expect(S.spawns).toEqual([req]);
    expect(S.prefills).toEqual([]);
    expect(S.remaining.items.map(i => i.agent)).toEqual([a]);

    // A serial prompt that landed leaves the plain item after it no room above softLimit either: one ledger.
    const t = agent(3, 'awaiting_tool');
    S = serial().schedule(state([agent(4), a, t], 2000, {}, { items: [recoveryItem(a, 1400), resultItem(t, 900)] }), withRecovery);
    expect(S.prefills.map(i => i.agent)).toEqual([a]);            // 1400 ≤ 2000 − 512; 900 > 976 − 1400
    expect(S.remaining.items.map(i => i.agent)).toEqual([t]);

    // Too big while a sibling decodes: carried, no stall.
    const live = agent(2);
    S = serial().schedule(state([live, a], 1000, {}, { items: [recoveryItem(a, 600)] }), withRecovery);
    expect(S.prefills).toEqual([]);
    expect(S.remaining.items.map(i => i.agent)).toEqual([a]);
    expect(S.stall).toEqual([]);

    // Too big with nothing left to free KV: the stall-break skips the recovery — no second `agent:done`, no re-decision.
    S = serial().schedule(state([a], 1000, {}, { items: [recoveryItem(a, 600)] }), withRecovery);
    expect(S.prefills).toEqual([]);
    expect(S.stall).toEqual([{ agent: a, nudge: null, drop: { agent: a, reason: 'settle_stall_break', done: false, recovery: { type: 'skip' } } }]);
    expect(S.remaining.items).toEqual([]);

    // A cohort turn that cannot fit its band is re-decided serial only when the serial rule admits it; otherwise skipped outright.
    const c = agent(5, 'awaiting_tool'); c.markExtracting(1000);
    S = scheduler().schedule(state([c], 1000, {}, { items: [recoveryItem(c, 300)] }), withRecovery);
    expect(S.stall[0]?.drop?.recovery).toMatchObject({ type: 'extract', serial: true });   // 300 ≤ 488
    S = scheduler().schedule(state([c], 1000, {}, { items: [recoveryItem(c, 600)] }), withRecovery);
    expect(S.stall[0]?.drop?.recovery).toEqual({ type: 'skip' });                         // 600 > 488
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
    let S = scheduler().schedule(oversized(a), { ...quiet, hooks: [{ beforeAdmit: () => ({ type: 'drop' }) }] });
    expect(S.stall).toHaveLength(1);
    expect(S.stall[0].nudge).toBeNull();
    expect(S.stall[0].drop?.agent).toBe(a);
    expect(S.stall[0].drop?.reason).toBe('pressure_settle_reject');
    expect(S.stall[0].drop?.done).toBe(true);

    a = mk();
    S = scheduler().schedule(oversized(a), quiet);
    expect(S.stall[0].drop?.reason).toBe('settle_stall_break');

    a = mk();
    S = scheduler().schedule(oversized(a), { ...quiet, hooks: [{ beforeAdmit: () => ({ type: 'nudge', message: 'report now' }) }] });
    expect(S.stall[0].nudge?.replacement?.kind).toBe('nudge');
    expect(S.stall[0].drop).toBeNull();
    expect(S.remaining.items).toEqual([S.stall[0].nudge!.replacement]);
  });

  it('the stall-break waits while any sibling can still make progress, for a plain item and a serial recovery turn alike', () => {
    const withRecovery: AgentPolicy = { ...quiet, onRecovery: () => ({ type: 'extract', prompt: { system: 's', user: 'u' } }) };
    const serial = () => scheduler({ recovery: 'serial' });
    const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
    // Two shapes of blocked owner: a plain oversized result, and a serial recovery prompt that cannot fit.
    const blocked = () => {
      const plain = agent(1, 'awaiting_tool');
      const rec = agent(2, 'awaiting_tool'); rec.markExtracting(Infinity, true);
      return { plain, rec, items: [resultItem(plain, 5000), recoveryItem(rec, 600)] };
    };
    const carried = (S: ReturnType<DefaultScheduler['schedule']>, b: ReturnType<typeof blocked>) => {
      expect(S.stall, 'the stall-break fired while a sibling could still make progress').toEqual([]);
      expect(S.remaining.items.map(i => i.agent)).toEqual([b.plain, b.rec]);
    };

    // A sibling with a tool in flight: its result is coming.
    let b = blocked(); const inflight = agent(3, 'awaiting_tool');
    carried(serial().schedule(state([b.plain, b.rec, inflight], 1000, { inflight: new Set([3]) }, { items: b.items }), withRecovery), b);
    // A sibling dispatching this schedule.
    b = blocked(); const dispatching = agent(3, 'awaiting_tool');
    carried(serial().schedule(state([b.plain, b.rec, dispatching], 1000, {}, { items: b.items, dispatches: [{ agent: dispatching, tc }] }), withRecovery), b);
    // A sibling with a parked retry, not yet due.
    b = blocked(); const parked = agent(3, 'awaiting_tool');
    carried(serial().schedule(state([b.plain, b.rec, parked], 1000, { wall: 0 }, { items: b.items, retries: [{ agent: parked, tc, callId: 'r', notBefore: 10, attempt: 1 }] }), withRecovery), b);
    // A sibling whose retry is abandoned by wind-down this schedule: an item next tick.
    b = blocked(); const abandoned = agent(3, 'awaiting_tool');
    carried(serial().schedule(state([b.plain, b.rec, abandoned], 1000, { signals: { paused: false, windDown: true, cancelled: [], orchestratorDone: false } }, { items: b.items, retries: [{ agent: abandoned, tc, callId: 'r', notBefore: 0, attempt: 1 }] }), withRecovery), b);
    // A sibling dropped this schedule: a prune is owed at the next observe.
    b = blocked(); const doomed = agent(3);
    let S = serial().schedule(state([b.plain, b.rec, doomed], 1000, {}, { items: b.items }), { ...withRecovery, shouldExit: () => true });
    expect(S.drops.map(d => d.agent)).toEqual([doomed]);
    carried(S, b);
    // A sibling finishing its extraction this schedule.
    b = blocked(); const finishing = agent(3); finishing.markExtracting(0);
    S = serial().schedule(state([b.plain, b.rec, finishing], 1000, {}, { items: b.items }), withRecovery);
    expect(S.finishes).toEqual([finishing]);
    carried(S, b);

    // Nothing left that can make progress: the stall-break fires for both.
    b = blocked();
    S = serial().schedule(state([b.plain, b.rec], 1000, {}, { items: b.items }), withRecovery);
    expect(S.stall.map(o => o.agent)).toEqual([b.plain, b.rec]);
    expect(S.remaining.items).toEqual([]);
  });

  it('outstanding obligations are not progress: a prune-requested parent with blocked children, and an rc-deferred item that no longer fits', () => {
    const withRecovery: AgentPolicy = { ...quiet, onRecovery: () => ({ type: 'extract', prompt: { system: 's', user: 'u' } }) };
    // The parent cannot be pruned while its children live, and its children are the blocked ones.
    const parent = agent(9, 'idle'); parent.transition('active'); parent.transition('idle'); parent.pruneRequested = true;
    const a = agent(1, 'awaiting_tool'); const b = agent(2, 'awaiting_tool');
    let S = scheduler().schedule(state([parent, a, b], 1000, {}, { items: [resultItem(a, 5000), resultItem(b, 5000)] }), withRecovery);
    expect(S.stall.map(o => o.agent), 'a pending prune on a non-leaf suppressed the stall-break').toEqual([a, b]);

    // An item the kernel refused once (rc 1) and that no longer fits admission is an oversized item like any other.
    const rc = agent(3, 'awaiting_tool'); rc.deferAttempts = 1;
    const other = agent(4, 'awaiting_tool');
    S = scheduler().schedule(state([rc, other], 1000, {}, { items: [resultItem(rc, 5000), resultItem(other, 5000)] }), withRecovery);
    expect(S.stall.map(o => o.agent), 'an rc-deferred item rode through the stall-break with no route back to admission').toEqual([rc, other]);
    expect(S.remaining.items).toEqual([]);
  });

  it('a deferred extend is carried on the same progress rule, and rejected when nothing can make progress', () => {
    const ext = { tokens: Array(5000).fill(1), userContent: 'u', assistantContent: 'a', resolve: () => {}, reject: () => {}, discarded: false };
    const inflight = agent(3, 'awaiting_tool');
    let S = scheduler().schedule(state([inflight], 1000, { inflight: new Set([3]) }, { extends: [ext] }), quiet);
    expect(S.remaining.extends).toEqual([ext]);
    expect(S.rejectedExtends).toEqual([]);
    S = scheduler().schedule(state([], 1000, {}, { extends: [ext] }), quiet);
    expect(S.rejectedExtends).toEqual([ext]);
  });

  it('an extracting agent is finished when the post-admission pressure turns critical, not only when its budget is spent', () => {
    // Serial: an infinite budget never finishes by itself; the hard reserve must.
    const serial = agent(1); serial.markExtracting(Infinity, true);
    let S = scheduler({ recovery: 'serial' }).schedule(state([serial], 100), quiet);      // remaining 100 < hardLimit 512
    expect(S.decode, 'a report decoded into a cache below the hard reserve').toEqual([]);
    expect(S.finishes).toEqual([serial]);
    expect(S.drops).toEqual([]);

    // Cohort: budget left, but the cache is already below the reserve — the
    // reservation lived only in the tick that admitted the turn.
    const cohort = agent(2); cohort.markExtracting(1000);
    S = scheduler().schedule(state([cohort], 100), quiet);
    expect(S.finishes).toEqual([cohort]);

    // Above the reserve, with budget left: decodes.
    const fine = agent(4); fine.markExtracting(1000);
    S = scheduler().schedule(state([fine], 2000), quiet);
    expect(S.decode).toEqual([fine]);
    expect(S.finishes).toEqual([]);
  });

  it('an explicit recoveryBudget is one budget for both paths: it caps the in-flight terminal call unchanged, above the adaptive ceiling too', () => {
    // 2048 is the ADAPTIVE ceiling, for when no budget is configured. An
    // explicit 3000 is honoured by cohort recovery (clamped only to what fits)
    // and must cap a voluntary report at 3000 as well, not at 2048.
    const reporting = emitting(agent(1), 'report');
    for (let i = 0; i < 2500; i++) reporting.accumulateToken('x');
    let S = scheduler({ recoveryBudget: 3000 }).schedule(state([reporting], 8000), quiet);
    expect(S.drops, 'the explicit budget was capped at the adaptive ceiling').toEqual([]);
    expect(S.decode).toEqual([reporting]);
    for (let i = 0; i < 500; i++) reporting.accumulateToken('x');
    S = scheduler({ recoveryBudget: 3000 }).schedule(state([reporting], 8000), quiet);
    expect(S.drops.map(d => d.reason)).toEqual(['terminal_cap']);

    // Without a configured budget the adaptive ceiling caps the report.
    const adaptive = emitting(agent(2), 'report');
    for (let i = 0; i < 2048; i++) adaptive.accumulateToken('x');
    S = scheduler().schedule(state([adaptive], 8000), quiet);
    expect(S.drops.map(d => d.reason)).toEqual(['terminal_cap']);
  });

  it('the adaptive cohort budget is shared among agents that will still hold KV — agents cancelled this schedule are not among them', () => {
    // remaining 3500, hardLimit 512, BATCH_BUFFER 512, OVERHEAD 150: three shares
    // give floor(2476 / 3) − 150 = 675; one share gives 2476 − 150 = 2326 → clamped 2048.
    const withRecovery: AgentPolicy = { ...quiet, onRecovery: () => ({ type: 'extract', prompt: { system: 's', user: 'u' } }), shouldExit: () => true };
    const a = agent(1); const b = agent(2); const c = agent(3);
    const cancelled = { paused: false, windDown: false, cancelled: [1, 2], orchestratorDone: false };
    const S = scheduler().schedule(state([a, b, c], 3500, { signals: cancelled }), withRecovery);
    expect(S.drops.map(d => [d.agent.id, d.reason])).toEqual([[1, 'user_cancel'], [2, 'user_cancel'], [3, 'policy_exit']]);
    expect(S.alive, 'cancelled agents counted as sharers of the reserve').toBe(1);
    expect(S.drops[2].recovery).toMatchObject({ type: 'extract', budget: 2048 });
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

  it('closes once the orchestrator is done, every agent is final and nothing waits — idle is final, nothing is swept', () => {
    const reported = agent(1, 'idle'); reported.setResult('r', 'voluntary_return');
    const discarded = agent(2, 'idle'); discarded.failed = 'user_cancel';
    const done = { paused: false, windDown: false, cancelled: [], orchestratorDone: true };
    const withRecovery: AgentPolicy = { ...quiet, onRecovery: () => ({ type: 'extract', prompt: { system: 's', user: 'u' } }) };

    let S = scheduler().schedule(state([reported, discarded], 8000, { signals: done }), withRecovery);
    expect(S.close).toBe(true);
    expect(S.drops).toEqual([]);

    // Not while the orchestrator may still spawn, nor while any agent is live.
    S = scheduler().schedule(state([reported, discarded], 8000), withRecovery);
    expect(S.close).toBe(false);
    S = scheduler().schedule(state([reported, agent(3)], 8000, { signals: done }), withRecovery);
    expect(S.close).toBe(false);
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

  it('one drop per agent per schedule: two cancels for the same live agent decide one drop', () => {
    // A double click is two signals in one tick. The agent reads live for both
    // (the drop is enacted after the schedule), so without the rule the second
    // would be a second terminal event and an idle → idle transition.
    const a = agent(7, 'awaiting_tool');
    const st = state([a], 8000, { signals: { paused: false, windDown: false, cancelled: [7, 7], orchestratorDone: false }, inflight: new Set([7]) });
    const S = scheduler().schedule(st, quiet);
    expect(S.drops.map(d => [d.agent.id, d.reason])).toEqual([[7, 'user_cancel']]);
    expect(S.halts).toEqual([a]);
  });
});
