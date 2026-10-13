/**
 * Receipt for LLO-42: a cohort dropped at the context reserve recovers with
 * room for whole reports.
 *
 * The numbers are the 03:10 Fieldnote trace of 2026-10-12: nCtx 32768, soft
 * 8192, hard 6144, remaining 8132 at the drop, three agents with results that
 * no longer fit. On that tick the pool once handed each report 342 tokens and
 * cut every annexure mid-sentence while 6144 cells sat unused. The scheduler
 * is a pure function, so the tick is replayed here exactly and the decision
 * read back.
 */
import { describe, it, expect } from 'vitest';
import { MockSessionContext } from '../../sdk/src/testing.js';
import { Agent } from '../src/Agent';
import { ContextPressure } from '../src/pressure';
import { DefaultScheduler, MAX_RECOVERY_BUDGET } from '../src/scheduler';
import { BATCH_BUFFER, RECOVERY_PROMPT_OVERHEAD, type AgentPolicy } from '../src/AgentPolicy';
import { emptyPending, type TickState, type PrefillItem } from '../src/state';
import { makeFrame } from '../src/hooks';
import { createMockBranch } from './helpers/mock-branch';
import { FMT } from './helpers/format-config';

const ctx = new MockSessionContext({ nCtx: 32768 });
const frame = makeFrame({ protectedTools: new Set(), grants: new Set() });
const scheduler = new DefaultScheduler({ recovery: 'cohort', terminalToolName: 'report' }, ctx as never, new Map(), frame);

/** Fieldnote's `medium` row. */
const THRESHOLDS = { softLimit: 8192, hardLimit: 6144 };
const N_CTX = 32768;

function pressureAt(remaining: number): ContextPressure {
  return new ContextPressure({ nCtx: N_CTX, cellsUsed: N_CTX - remaining, remaining }, THRESHOLDS);
}

function agent(id: number, status: 'active' | 'awaiting_tool'): Agent {
  const a = new Agent({ id, parentId: 0, branch: createMockBranch({ handle: id }) as never, fmt: FMT });
  a.transition('active');
  if (status === 'awaiting_tool') a.transition('awaiting_tool');
  return a;
}

function tick(agents: Agent[], remaining: number, items: PrefillItem[] = []): TickState {
  return {
    tick: 0, now: 0, wall: 0,
    pressure: pressureAt(remaining),
    agents,
    pending: { ...emptyPending(), items },
    signals: { paused: false, windDown: false, cancelled: [], orchestratorDone: false },
    inflight: new Set(),
    sequences: Infinity,
  };
}

const resultItem = (a: Agent, tokens: number): PrefillItem =>
  ({ kind: 'toolResult', rail: 'token', agent: a, tokens: Array(tokens).fill(1), toolName: 'fetch_page', callId: 'c1', args: '{}' });

/** Fieldnote's shape at the drop: the admit hook nudges, recovery extracts. */
const policy: AgentPolicy = {
  onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
  hooks: [{ beforeAdmit: () => ({ type: 'nudge', message: 'The result does not fit. Report now with what you have.' }) }],
  shouldExit: () => false,
  onRecovery: () => ({ type: 'extract', prompt: { systemPrompt: 'recover', content: 'Report now.' } }),
};

describe('receipt: cohort recovery at the context reserve (LLO-42)', () => {
  it('three agents whose results no longer fit are dropped in one tick, each with a share of the room that holds a report', () => {
    const agents = [3, 4, 5].map(id => agent(id, 'awaiting_tool'));
    // 5 to 10k-char pages: about 2000 cells each, against a headroom of 8132 - 8192 = -60.
    const S = scheduler.schedule(tick(agents, 8132, agents.map(a => resultItem(a, 2000))), policy);

    expect(S.decode).toEqual([]);
    expect(S.stall.map(o => o.drop?.reason)).toEqual(['pressure_settle_reject', 'pressure_settle_reject', 'pressure_settle_reject']);
    expect(S.stall.map(o => o.drop?.done)).toEqual([true, true, true]);
    const budgets = S.stall.map(o => (o.drop!.recovery as { budget: number }).budget);
    // (8132 - 512) / 3 - 150 = 2390 of room each, granted at the 2048 ceiling. It was 342 when the hard line was subtracted.
    expect(Math.floor((8132 - BATCH_BUFFER) / 3) - RECOVERY_PROMPT_OVERHEAD).toBe(2390);
    expect(budgets).toEqual([MAX_RECOVERY_BUDGET, MAX_RECOVERY_BUDGET, MAX_RECOVERY_BUDGET]);
    // The whole cohort's prompts and reports fit what physically remains above the floor.
    expect(3 * (RECOVERY_PROMPT_OVERHEAD + MAX_RECOVERY_BUDGET)).toBeLessThanOrEqual(8132 - BATCH_BUFFER);
  });

  it('a recovering agent keeps decoding below the hard line: the reserve is the report\'s to spend', () => {
    const a = agent(3, 'active');
    a.markExtracting(2390);
    for (let i = 0; i < 342; i++) a.accumulateToken('x');
    // 6000 remaining: below the hard line of 6144, 5488 cells above the floor.
    const S = scheduler.schedule(tick([a], 6000), policy);
    expect(S.decode).toEqual([a]);
    expect(S.finishes).toEqual([]);
    expect(S.drops).toEqual([]);
  });

  it('a serial recovery with no cap runs to the floor, not to the hard line (the 967-token case)', () => {
    const a = agent(3, 'active');
    a.markExtracting(Infinity, true);
    for (let i = 0; i < 967; i++) a.accumulateToken('x');
    const serial = new DefaultScheduler({ recovery: 'serial', terminalToolName: 'report' }, ctx as never, new Map(), frame);
    expect(serial.schedule(tick([a], 6100), policy).decode).toEqual([a]);
    expect(serial.schedule(tick([a], BATCH_BUFFER - 1), policy).finishes).toEqual([a]);
  });
});
