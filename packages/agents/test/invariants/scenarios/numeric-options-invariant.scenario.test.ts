/**
 * Scenario: the pool refuses a numeric option that would silently break it.
 *
 * `recoveryBudget` caps every recovery turn and the voluntary terminal call;
 * at zero, negative or NaN the cap is met at the first token, so every report
 * is cut immediately and every recovery finishes empty — a run that looks
 * alive and yields nothing. `maxConcurrentTools` gates fan-out tools; at zero
 * or negative no permit is ever granted and the first fan-out call hangs the
 * agent forever. Both are public numbers read raw at open.
 *
 * What this locks: `useAgentPool` validates them where it already validates
 * `hardLimit >= nBatch` — at entry, with the value named — instead of letting
 * the run fail quietly later.
 */
import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';

const quiet = (over: Partial<AgentPolicy> = {}): AgentPolicy => ({
  onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
  onRecovery: () => ({ type: 'skip' }),
  shouldExit: () => false,
  ...over,
});

describe('scenario: numeric options are validated at open', () => {
  for (const bad of [0, -5, Number.NaN, 1.5]) {
    it(`recoveryBudget ${bad} → the pool refuses to start`, async () => {
      await expect(runPool({
        nCtx: 4096, scripts: [{ tokens: [1, STOP] }],
        policy: quiet({ recoveryBudget: bad }),
      })).rejects.toThrow(/recoveryBudget/);
    });
  }
  for (const bad of [0, -1, Number.NaN, 2.5]) {
    it(`maxConcurrentTools ${bad} → the pool refuses to start`, async () => {
      await expect(runPool({
        nCtx: 4096, scripts: [{ tokens: [1, STOP] }],
        policy: quiet(), maxConcurrentTools: bad,
      })).rejects.toThrow(/maxConcurrentTools/);
    });
  }
  it('valid values start cleanly', async () => {
    const run = await runPool({
      nCtx: 4096, scripts: [{ tokens: [1, STOP], content: 'done' }],
      policy: quiet({ recoveryBudget: 256 }), maxConcurrentTools: 2,
    });
    expect(run.result.agents).toHaveLength(1);
  });
});
