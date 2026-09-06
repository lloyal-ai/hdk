/**
 * Scenario: a recovery report that never emits a stop token is finished when
 * the cache reaches the hard reserve, not when the cache is gone.
 *
 * An extracting agent is exempt from the critical-pressure exit — its report
 * was granted the room — and a serial report's budget is infinite. Nothing
 * therefore bounded a report the model would not end: the loop kept
 * committing past `hardLimit` until the native decode failed and the pool
 * closed partial, taking every sibling's result with it.
 *
 * What this locks: an extracting agent is finished — its output salvaged the
 * way the terminal cap salvages — as soon as the post-admission pressure is
 * critical, so the run closes normally and no commit is ever issued into a
 * cache below the reserve.
 */
import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';

const policy: AgentPolicy = {
  onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
  onRecovery: () => ({ type: 'extract', prompt: { system: 's', user: 'u' } }),
  shouldExit: () => false,
  recoveryShape: 'staggered',
};

describe('scenario: a report that never stops is finished at the hard reserve', () => {
  it('no commit below hardLimit; the report is salvaged; the run closes normally', async () => {
    const run = await runPool({
      // Room for the prompt and a few hundred tokens of report, then the reserve.
      nCtx: 1200, cellsUsed: 0,
      captureError: true,
      // One turn, STOP (idle) → recovery turn → a report that never stops.
      scripts: [{ tokens: [1, STOP, ...Array(5000).fill(1)] }],
      policy,
      instrument: (ctx) => {
        // The kernel's refusal the mock lacks: no KV slot for a commit that
        // would exceed the context.
        const inner = ctx._storeCommit.bind(ctx);
        ctx._storeCommit = async (handles, tokens) => {
          if (ctx.cellsUsed + handles.length > ctx.nCtx) {
            throw Object.assign(new Error(`find_slot: no KV slot for the batch (${ctx.cellsUsed} + ${handles.length} > ${ctx.nCtx})`), { rc: 1 });
          }
          return inner(handles, tokens);
        };
      },
    });

    expect(run.error, `the pool threw: ${String((run.error as Error)?.message ?? run.error)}`).toBeUndefined();
    expect(run.traceEvents.some(e => e.type === 'pool:close'), 'the run was torn down, not completed').toBe(true);
    // The report was finished, not lost: one recovery outcome, and the extractor's span is announced.
    const outcomes = run.traceEvents.filter(e => e.type === 'pool:recoveryReturn' || e.type === 'pool:recoveryFailed');
    expect(outcomes).toHaveLength(1);
    expect(run.traceEvents.some(e => e.type === 'pool:recoveryProduce')).toBe(true);
    // Every commit left at least the hard reserve.
    const ticks = run.traceEvents.filter(e => e.type === 'pool:tick') as { pressure: { remaining: number } }[];
    expect(ticks.length).toBeGreaterThan(0);
    expect(Math.min(...ticks.map(t => t.pressure.remaining)), 'a commit landed below the hard reserve').toBeGreaterThanOrEqual(0);
    expect(run.result.agents[0].agent.status).toBe('disposed');
  });
});
