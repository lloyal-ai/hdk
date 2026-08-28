/**
 * The policy's bound clock — time budgets measure what the clock says, and
 * the pool's run clock excludes pauses. Pure unit: no pool, no sleeps; a
 * fake clock advances by assignment and every time knob flips at the right
 * virtual instant.
 */
import { describe, it, expect } from 'vitest';
import { DefaultAgentPolicy } from '../src/AgentPolicy';
import { ContextPressure } from '../src/agent-pool';
import type { Agent } from '../src/Agent';

const fakePressure = (percentAvailable = 90): ContextPressure =>
  ({
    critical: false,
    percentAvailable,
    headroom: 10_000,
    remaining: 20_000,
    hardLimit: 512,
    softLimit: 1024,
    canFit: () => true,
  } as unknown as ContextPressure);

const agentAt = (startedAt: number): Agent =>
  ({ startedAt, currentTool: null, turns: 0 } as unknown as Agent);

describe('bindClock', () => {
  it('shouldExit flips at the bound clock, not the wall clock', () => {
    let t = 0;
    const policy = new DefaultAgentPolicy({
      budget: { time: { hardLimit: 100 } },
    });
    policy.bindClock(() => t);
    const a = agentAt(0);
    t = 99;
    expect(policy.shouldExit(a, fakePressure())).toBe(false);
    t = 100;
    expect(policy.shouldExit(a, fakePressure())).toBe(true);
  });

  it('an agent started later measures its OWN run time', () => {
    let t = 0;
    const policy = new DefaultAgentPolicy({ budget: { time: { hardLimit: 100 } } });
    policy.bindClock(() => t);
    t = 500;
    const late = agentAt(500); // stamped through the same clock
    t = 599;
    expect(policy.shouldExit(late, fakePressure())).toBe(false);
    t = 600;
    expect(policy.shouldExit(late, fakePressure())).toBe(true);
  });

  it('shouldExplore time ratio reads the bound clock', () => {
    let t = 0;
    const policy = new DefaultAgentPolicy({
      budget: { time: { softLimit: 200 } },
      shouldExplore: { time: 0.5, context: 0.1 },
    });
    policy.bindClock(() => t);
    const a = agentAt(0);
    t = 99;  // 99/200 < 0.5 → explore
    expect(policy.shouldExplore(a, fakePressure())).toBe(true);
    t = 100; // 100/200 = 0.5 → exploit
    expect(policy.shouldExplore(a, fakePressure())).toBe(false);
  });

  it('unbound, time reads performance.now (the default holds)', () => {
    const policy = new DefaultAgentPolicy({ budget: { time: { hardLimit: 10_000_000 } } });
    expect(policy.shouldExit(agentAt(performance.now()), fakePressure())).toBe(false);
  });
});
