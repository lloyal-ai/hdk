/**
 * A report lives above the floor; research turns live above the soft and hard
 * lines. These are the edges of that rule, as the pure scheduler decides them
 * and as the pressure value states them.
 */
import { describe, it, expect } from 'vitest';
import { MockSessionContext } from '../../sdk/src/testing.js';
import { Agent } from '../src/Agent';
import { ContextPressure } from '../src/pressure';
import { DefaultScheduler, MAX_RECOVERY_BUDGET, MIN_RECOVERY_BUDGET, recoveryFor } from '../src/scheduler';
import { BATCH_BUFFER, RECOVERY_PROMPT_OVERHEAD, type AgentPolicy } from '../src/AgentPolicy';
import { emptyPending, type TickState, type PrefillItem } from '../src/state';
import { makeFrame } from '../src/hooks';
import { createMockBranch } from './helpers/mock-branch';
import { FMT } from './helpers/format-config';

const ctx = new MockSessionContext({ nCtx: 32768 });
const frame = makeFrame({ protectedTools: new Set(), grants: new Set() });
const THRESHOLDS = { softLimit: 8192, hardLimit: 6144 };
const N_CTX = 32768;

const cohort = () => new DefaultScheduler({ recovery: 'cohort', terminalToolName: 'report' }, ctx as never, new Map(), frame);
const serial = () => new DefaultScheduler({ recovery: 'serial', terminalToolName: 'report' }, ctx as never, new Map(), frame);

const at = (remaining: number) => new ContextPressure({ nCtx: N_CTX, cellsUsed: N_CTX - remaining, remaining }, THRESHOLDS);

function agent(id: number, status: 'active' | 'awaiting_tool' = 'active'): Agent {
  const a = new Agent({ id, parentId: 0, branch: createMockBranch({ handle: id }) as never, fmt: FMT });
  a.transition('active');
  if (status === 'awaiting_tool') a.transition('awaiting_tool');
  return a;
}

function tick(agents: Agent[], remaining: number, items: PrefillItem[] = []): TickState {
  return {
    tick: 0, now: 0, wall: 0, pressure: at(remaining), agents,
    pending: { ...emptyPending(), items },
    signals: { paused: false, windDown: false, cancelled: [], orchestratorDone: false },
    inflight: new Set(), sequences: Infinity,
  };
}

const recoveryItem = (a: Agent, cells: number): PrefillItem =>
  ({ kind: 'recovery', rail: 'token', agent: a, tokens: Array(cells).fill(1), toolName: 'recovery', callId: `recovery:${a.id}`, args: '' });

const extracting: AgentPolicy = {
  onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
  shouldExit: () => false,
  onRecovery: () => ({ type: 'extract', prompt: { systemPrompt: 'recover', content: 'Report now.' } }),
};

describe('the floor on the pressure value', () => {
  it('is the decode workspace, and room is what lies above it', () => {
    const p = at(8132);
    expect(p.floor).toBe(ContextPressure.ASSUMED_N_BATCH);
    expect(p.room).toBe(8132 - p.floor);
    expect(BATCH_BUFFER).toBe(p.floor);
  });
  it('room is negative below the floor and unbounded without a context limit', () => {
    expect(at(100).room).toBeLessThan(0);
    const unlimited = new ContextPressure({ nCtx: 0, cellsUsed: 0, remaining: 0 }, THRESHOLDS);
    expect(unlimited.room).toBe(Infinity);
  });
  it('minus() carries the floor with the snapshot', () => {
    expect(at(8132).minus(1000).room).toBe(7132 - BATCH_BUFFER);
  });
});

describe('the cohort share is a share of the room', () => {
  const share = (remaining: number, alive: number, explicit?: number) =>
    (recoveryFor(agent(1), extracting, at(remaining), alive, 'cohort', explicit) as { budget: number }).budget;

  it('the 03:10 tick: three agents at 8132 remaining have 2390 of room each, granted at the ceiling, not 342', () => {
    expect(Math.floor((8132 - BATCH_BUFFER) / 3) - RECOVERY_PROMPT_OVERHEAD).toBe(2390);
    expect(share(8132, 3)).toBe(MAX_RECOVERY_BUDGET);
    // Under the ceiling the share is the room's: five agents at the same tick.
    expect(share(8132, 5)).toBe(Math.floor((8132 - BATCH_BUFFER) / 5) - RECOVERY_PROMPT_OVERHEAD);
  });
  it('one agent with ample room is capped at the ceiling', () => {
    expect(share(20000, 1)).toBe(MAX_RECOVERY_BUDGET);
  });
  it('a room too small for the overhead floors at the minimum', () => {
    expect(share(BATCH_BUFFER + 100, 3)).toBe(MIN_RECOVERY_BUDGET);
  });
  it('an explicit budget is clamped down to the share, never up', () => {
    expect(share(8132, 3, 300)).toBe(300);
    expect(share(8132, 5, 3000)).toBe(Math.floor((8132 - BATCH_BUFFER) / 5) - RECOVERY_PROMPT_OVERHEAD);
  });
  it('the hard line does not enter the share: a research kill line of 6144 and one of 1024 give the same share', () => {
    const low = new ContextPressure({ nCtx: N_CTX, cellsUsed: N_CTX - 8132, remaining: 8132 }, { softLimit: 2048, hardLimit: 1024 });
    expect((recoveryFor(agent(1), extracting, low, 3, 'cohort', undefined) as { budget: number }).budget).toBe(share(8132, 3));
  });
});

describe('a recovery turn is admitted against the room', () => {
  it('a cohort recovery whose prompt plus budget fits the room is admitted under negative headroom, beyond the old band', () => {
    const a = agent(3, 'awaiting_tool'); a.markExtracting(2390);
    // remaining 8132: headroom -60, band 2048, room 7620; prompt 200 + budget 2390 = 2590 fits the room only.
    const S = cohort().schedule(tick([a], 8132, [recoveryItem(a, 200)]), extracting);
    expect(S.prefills.map(i => i.agent)).toEqual([a]);
    expect(S.remaining.items).toEqual([]);
  });
  it('a cohort recovery that would overrun the room waits', () => {
    const a = agent(3, 'awaiting_tool'); a.markExtracting(2390);
    const S = cohort().schedule(tick([a], BATCH_BUFFER + 2500, [recoveryItem(a, 200)]), extracting);
    expect(S.prefills).toEqual([]);
  });
  it('a serial prompt fits what remains above the floor, not above the hard line', () => {
    const a = agent(3, 'awaiting_tool'); a.markExtracting(Infinity, true);
    // 1000 cells of prompt, remaining 2000: above the floor there are 1488, above the hard line there would be none.
    const S = serial().schedule(tick([a], 2000, [recoveryItem(a, 1000)]), extracting);
    expect(S.prefills.map(i => i.agent)).toEqual([a]);
  });
  it('the ledger charges a cohort reservation once: two recoveries share one room', () => {
    const a = agent(3, 'awaiting_tool'); a.markExtracting(2000);
    const b = agent(4, 'awaiting_tool'); b.markExtracting(2000);
    // room 4000: the first (200 + 2000) is admitted, the second does not fit what is left.
    const S = cohort().schedule(tick([a, b], BATCH_BUFFER + 4000, [recoveryItem(a, 200), recoveryItem(b, 200)]), extracting);
    expect(S.prefills.map(i => i.agent)).toEqual([a]);
    expect(S.remaining.items.map(i => i.agent)).toEqual([b]);
  });
});

describe('a report is finished at its budget or at the floor, never at the hard line', () => {
  it('decodes below the hard line while budget and room remain', () => {
    const a = agent(3); a.markExtracting(2390);
    for (let i = 0; i < 300; i++) a.accumulateToken('x');
    const S = cohort().schedule(tick([a], 6000), extracting);   // below hard 6144, far above the floor
    expect(S.decode).toEqual([a]);
    expect(S.finishes).toEqual([]);
    expect(S.drops).toEqual([]);
  });
  it('finishes when the counter reaches the budget', () => {
    const a = agent(3); a.markExtracting(2390);
    for (let i = 0; i < 2390; i++) a.accumulateToken('x');
    const S = cohort().schedule(tick([a], 6000), extracting);
    expect(S.finishes).toEqual([a]);
  });
  it('finishes when the room is gone, with budget left', () => {
    const a = agent(3); a.markExtracting(2390);
    const S = cohort().schedule(tick([a], BATCH_BUFFER - 1), extracting);
    expect(S.finishes).toEqual([a]);
    expect(S.decode).toEqual([]);
  });
  it('a serial report with no cap runs to the floor', () => {
    const a = agent(3); a.markExtracting(Infinity, true);
    expect(serial().schedule(tick([a], 1000), extracting).decode).toEqual([a]);
    expect(serial().schedule(tick([a], BATCH_BUFFER - 1), extracting).finishes).toEqual([a]);
  });
  it('a working turn is still killed at the hard line when the policy abstains', () => {
    const a = agent(3);
    const abstaining: AgentPolicy = { onProduced: extracting.onProduced, onRecovery: extracting.onRecovery };
    const S = cohort().schedule(tick([a], 6000), abstaining);
    expect(S.drops.map(d => d.reason)).toEqual(['pressure_critical']);
  });
});
