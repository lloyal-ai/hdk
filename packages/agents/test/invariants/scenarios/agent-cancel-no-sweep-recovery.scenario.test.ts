/**
 * Invariant: a user-cancelled agent is DISCARDED — the staggered termination sweep must
 * NOT force-recover it, even when its branch couldn't be pruned.
 *
 * `safePrune` only reclaims childless leaves. An agent that spawned a sub-agent (recursion
 * is a standing capability) has `branch.children.length > 0`, so `safePrune` no-ops at
 * cancel and the branch stays non-disposed. The termination sweep recovers any agent left
 * `idle && !result && !branch.disposed` — so pre-fix it would `recoverInline()` the
 * cancelled agent, emitting a SECOND terminal event (here `agent:failed(recovery_skipped)`)
 * after the `agent:failed(user_cancel)`. The `cancelledIds` guard excludes it.
 *
 * (PR #26 Copilot review, agent-pool.ts:1911.)
 */
import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import type { Orchestrator } from '../../../src/orchestrators';
import { runPool, STOP } from '../harness';

// Non-leaf topology: agent A has a spawned child B forked from A's own branch.
const nested: Orchestrator = function* (ctx) {
  const a = yield* ctx.spawn({ content: 'A', systemPrompt: 'You are A.', seed: 0 });
  yield* ctx.spawn({ content: 'B', systemPrompt: 'You are B.', seed: 1, parent: a.branch });
};

describe('scenario: cancelled non-leaf agent is not force-recovered by the sweep', () => {
  it('cancel A (has child B) → exactly one terminal agent:failed (user_cancel), no sweep recovery', async () => {
    const policy: AgentPolicy = {
      recoveryShape: 'staggered', // staggered ⇒ the termination sweep runs at pool close
      onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
      onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      onRecovery: () => ({ type: 'skip' }),
    };

    const run = await runPool({
      nCtx: 8000,
      cellsUsed: 0,
      // A: long run — stays active until cancelled. B: short — idles fast, leaving A the
      // idle-no-result-non-disposed leftover the sweep would otherwise pick up.
      scripts: [
        { tokens: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, STOP] }, // A (fork 0)
        { tokens: [1, STOP], content: 'b' },               // B (fork 1, child of A)
      ],
      policy,
      orchestrate: nested,
      terminalToolName: 'report',
      // A is the first agent to spawn; cancel it.
      cancelAfter: (ev) => (ev.type === 'agent:spawn' ? ev.agentId : null),
    });

    // Exactly one user_cancel; capture the cancelled agent id.
    const cancelled = run.channelEvents.filter(
      e => e.type === 'agent:failed' && (e as { reason?: string }).reason === 'user_cancel',
    );
    expect(cancelled.length).toBe(1);
    const aId = (cancelled[0] as { agentId: number }).agentId;

    // The cancelled agent must have EXACTLY ONE terminal event (the user_cancel) and NO
    // recovery. Pre-fix, the sweep's recoverInline(A) emits a second agent:failed
    // (recovery_skipped) — this assertion is red then.
    const aFailures = run.channelEvents.filter(
      e => e.type === 'agent:failed' && (e as { agentId: number }).agentId === aId,
    );
    expect(aFailures.length).toBe(1);
    expect((aFailures[0] as { reason: string }).reason).toBe('user_cancel');
    expect(
      run.channelEvents.some(e => e.type === 'agent:recovered' && (e as { agentId: number }).agentId === aId),
    ).toBe(false);
    // No recovery prefill ran for the cancelled agent (recoverInline never entered).
    const aRecoveryPrefills = run.traceEvents.filter(
      e => e.type === 'branch:prefill'
        && (e as { role?: string }).role === 'recovery'
        && (e as { branchHandle?: number }).branchHandle === aId,
    );
    expect(aRecoveryPrefills.length).toBe(0);
  });
});
