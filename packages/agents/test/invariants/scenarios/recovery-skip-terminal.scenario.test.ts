/**
 * Invariant: a SKIPPED recovery still emits a terminal event, so the agent isn't orphaned.
 *
 * `onRecovery` returns `{type:'skip'}` when the policy judges the agent too thin to force a
 * report (DefaultAgentPolicy skips below its minTokens/minToolCalls floor — the real-world
 * trigger: a runaway agent nudged off before it made ≥2 tool calls). `agent:done` ALREADY
 * fired at the drop, so without a follow-up terminal event the consumer orphans the agent —
 * an eternal "recovering" state whose card sits on its last "Thought" row (no report ever
 * streams) with a timer that never freezes.
 *
 * Locks: every agent that got `agent:done` gets a resolving terminal event, even on skip
 * (both `handleRecover`, parallel, and `recoverInline`, staggered).
 */
import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';

describe('scenario: skipped recovery emits agent:failed (no orphan)', () => {
  it('drop → onRecovery skip → agent:failed (recovery_skipped), not silence', async () => {
    const policy: AgentPolicy = {
      recoveryShape: 'parallel',
      onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
      onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      onRecovery: () => ({ type: 'skip' }), // force the skip the research policy hit in the wild
    };

    // Free-text turn 1 (`1, 2, STOP`) → onProduced idle → the parallel idle path emits
    // agent:done then calls handleRecover → onRecovery skip.
    const run = await runPool({
      nCtx: 4096,
      cellsUsed: 0,
      scripts: [{ tokens: [1, 2, STOP], content: 'thin output' }],
      policy,
      terminalToolName: 'report',
    });

    const done = run.channelEvents.filter(e => e.type === 'agent:done');
    const failed = run.channelEvents.filter(e => e.type === 'agent:failed');
    // agent:done fired once at the drop; the skip must be followed by a terminal agent:failed
    // (pre-fix: handleRecover returned null silently → failed.length === 0 → orphan).
    expect(done.length).toBe(1);
    expect(failed.length).toBe(1);
    expect((failed[0] as { reason: string }).reason).toBe('recovery_skipped');
    // No agent:recovered — there is no report (correct; the agent was too thin to extract).
    expect(run.channelEvents.some(e => e.type === 'agent:recovered')).toBe(false);
  });
});
