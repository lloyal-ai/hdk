/**
 * Scenario: without a terminal tool, a recovery turn's prose IS the result.
 *
 * The voluntary path already reads that way: with no terminal tool designated,
 * the default policy returns an agent's prose as `free_text_return`. Recovery
 * is that path's forced twin, and its own comment said "without one, whatever
 * the model produced" — but the code took the first tool call and, finding
 * none, failed the recovery with `no_terminal_call`. Reachable: the rig's
 * `delegate` pools designate no terminal tool, so any policy with a recovery
 * prompt recovered into failure there every time.
 *
 * What this locks: with no terminal tool, a recovery turn that produces prose
 * recovers with that prose; a terminal call, when designated, is still required.
 */
import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';

const policy: AgentPolicy = {
  onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
  onRecovery: () => ({ type: 'extract', prompt: { system: 's', user: 'u' } }),
  shouldExit: () => false,
};

describe('scenario: recovery without a terminal tool', () => {
  it('the recovery turn\'s prose becomes the result', async () => {
    const run = await runPool({
      nCtx: 8192, cellsUsed: 0,
      // No terminal tool, no tools at all: a text-only pool.
      scripts: [{ tokens: [1, STOP, 1, STOP], content: 'the findings' }],
      policy,
    });
    const recovered = run.channelEvents.filter(e => e.type === 'agent:recovered') as { result: string }[];
    expect(recovered.map(r => r.result)).toEqual(['the findings']);
    expect(run.traceEvents.some(e => e.type === 'pool:recoveryReturn')).toBe(true);
    expect(run.traceEvents.some(e => e.type === 'pool:recoveryFailed')).toBe(false);
    expect(run.result.agents.map(a => a.result)).toEqual(['the findings']);
  });
});
