/**
 * Scenario: a spawn request discarded while its batch is in flight is not
 * activated.
 *
 * Admission checks `discarded` before the batched prefill; activation ran
 * after it and did not. The prefill is a native call the loop suspends on,
 * and during that suspension wind-down halts the orchestrator, whose `action`
 * cleanups mark every pending spawn discarded. The executor then registered
 * the fork, announced `agent:spawn` after `run:windingDown`, and the agent was
 * reaped a tick later — a spawn nobody awaited, alive in a draining pool.
 *
 * What this locks: the forks of a batch are owned by the executor until they
 * enter the roster, on every path out of the window; a request discarded
 * while the batch landed is pruned and disposed, never announced; nothing but
 * the root outlives the pool (I42).
 */
import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';
import { I42_noLeakedBranches, formatResult } from '../predicates';

const policy: AgentPolicy = {
  onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
  onRecovery: () => ({ type: 'skip' }),
  shouldExit: () => false,
};

describe('scenario: a spawn discarded mid-batch is not activated', () => {
  it('wind-down during the spawn batch: no agent:spawn after run:windingDown, nothing leaked', async () => {
    let windDown: (() => void) | null = null;
    let fired = false;
    const run = await runPool({
      nCtx: 8192, cellsUsed: 0,
      captureError: true,
      scripts: [{ tokens: [1, STOP] }, { tokens: [1, STOP] }],
      policy,
      signals: s => { windDown = s.windDown; },
      instrument: (ctx) => {
        const inner = ctx._storePrefill.bind(ctx);
        ctx._storePrefill = async (handles, tokenArrays) => {
          // The spawn batch (two forks) is where wind-down lands, while the
          // loop is suspended on this call. A real timer, so the watcher runs.
          if (handles.length >= 2 && !fired) {
            fired = true;
            windDown!();
            await new Promise(r => setTimeout(r, 10));
          }
          return inner(handles, tokenArrays);
        };
      },
    });

    expect(fired, 'the spawn batch never happened').toBe(true);
    expect(run.error, `the pool threw: ${String((run.error as Error)?.message ?? run.error)}`).toBeUndefined();
    expect(run.traceEvents.some(e => e.type === 'pool:close'), 'the run was torn down, not completed').toBe(true);

    const bus = run.channelEvents.map(e => e.type);
    const windingDown = bus.indexOf('run:windingDown');
    expect(windingDown, 'wind-down never reached the bus').toBeGreaterThanOrEqual(0);
    expect(bus.slice(windingDown).filter(t => t === 'agent:spawn'), 'a discarded spawn was announced after wind-down').toEqual([]);
    expect(run.traceEvents.filter(e => e.type === 'branch:create' && (e as { role?: string }).role === 'agentFork')).toEqual([]);
    expect(run.result.agents).toEqual([]);
    expect(formatResult('I42', I42_noLeakedBranches(run))).toBe('I42: ok');
  });
});
