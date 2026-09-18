/**
 * Scenario: the same agent cancelled twice in one tick is dropped once.
 *
 * A cancel is one signal per UI command (the research harness sends
 * `runner.cancelAgent` for every `cancel:agent` it receives), so a double click
 * is two signals, and both drain into the same tick. The scheduler decided a
 * drop for each: the agent still read live for the second, because a drop is
 * enacted after the schedule. The second enactment emitted a second terminal
 * event and asked the lifecycle table for `idle → idle`, which throws, and the
 * pool's outer catch closed the run partial — the sibling lost.
 *
 * What this locks: one drop per agent per schedule (the verdicts already
 * kept that rule for themselves; the cancels now do too), one terminal event,
 * the sibling finishes, the run closes normally.
 */
import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';

const policy: AgentPolicy = {
  onProduced: (_a, parsed) => parsed.toolCalls[0]?.name === 'report'
    ? { type: 'return', result: 'done' }
    : { type: 'idle', reason: 'free_text_stop' },
  onRecovery: () => ({ type: 'skip' }),
  shouldExit: () => false,
};

describe('scenario: the same agent cancelled twice in one tick', () => {
  it('is dropped once; the sibling finishes and the run closes', async () => {
    let first: number | null = null;
    const run = await runPool({
      nCtx: 8192, cellsUsed: 0,
      captureError: true,
      terminalToolName: 'report',
      scripts: [
        { tokens: [...Array(20).fill(1), STOP], toolCall: { name: 'report', arguments: '{"result":"done"}' } },
        { tokens: [...Array(20).fill(1), STOP], toolCall: { name: 'report', arguments: '{"result":"done"}' } },
      ],
      policy,
      pauseAfter: (ev) => {
        if (ev.type === 'agent:spawn' && first === null) first = ev.agentId;
        return ev.type === 'agent:spawn';
      },
      whilePaused: async (h) => {
        // Two signals, one tick: both drain into the same hold tick.
        h.cancel(first!);
        h.cancel(first!);
        await new Promise((r) => setTimeout(r, 40));
      },
    });

    expect(run.error, `the pool threw: ${String((run.error as Error)?.message ?? run.error)}`).toBeUndefined();
    expect(run.traceEvents.some(e => e.type === 'pool:close'), 'the run was torn down, not completed').toBe(true);
    const failed = run.channelEvents.filter(e => e.type === 'agent:failed') as { agentId: number; reason: string }[];
    expect(failed.map(f => [f.agentId, f.reason])).toEqual([[first, 'user_cancel']]);
    expect(run.traceEvents.filter(e => e.type === 'pool:agentDrop')).toHaveLength(1);
    expect(run.result.agents.filter(a => a.agentId !== first).map(a => a.result)).toEqual(['done']);
  });
});
