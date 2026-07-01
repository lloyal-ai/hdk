/**
 * Invariant: a per-agent `CancelAgent.send({agentId})` DISCARDS exactly that agent —
 * one terminal `agent:failed` (reason `user_cancel`), its branch pruned, NO recovery,
 * no orphan. Mirrors the Artifact per-card × (halt the agent's tool + prune, reclaiming
 * its KV for siblings) while the pool keeps running.
 *
 * The drain runs on the loop fiber before PRODUCE, so an `active` agent is pulled out
 * before it joins the batched decode (here the agent has a long token run to stay live
 * across the tick or two the signal→watcher→queue hop takes).
 */
import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';

describe('scenario: per-agent cancel discards one agent (user_cancel)', () => {
  it('CancelAgent → agent:failed (user_cancel) + pool:agentDrop, no recovery, no orphan', async () => {
    const policy: AgentPolicy = {
      recoveryShape: 'parallel',
      onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
      onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      // If the cancel somehow missed, the agent would free-text → recover; the assertions
      // below (exactly one agent:failed=user_cancel, zero recovered) would then fail loud.
      onRecovery: () => ({ type: 'extract', prompt: { system: 's', user: 'u' } }),
    };

    const run = await runPool({
      nCtx: 4096,
      cellsUsed: 0,
      // Long run keeps the agent `active` for many ticks so the cancel lands while it's live.
      scripts: [{ tokens: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, STOP] }],
      policy,
      terminalToolName: 'report',
      // Fire the cancel on the agent's spawn, targeting its own id.
      cancelAfter: (ev) => (ev.type === 'agent:spawn' ? ev.agentId : null),
    });

    const failed = run.channelEvents.filter(e => e.type === 'agent:failed');
    expect(failed.length).toBe(1);
    expect((failed[0] as { reason: string }).reason).toBe('user_cancel');
    // Discard, not recover — no forced report.
    expect(run.channelEvents.some(e => e.type === 'agent:recovered')).toBe(false);
    // The drop is traced as user_cancel (exactly one).
    const drops = run.traceEvents.filter(
      e => e.type === 'pool:agentDrop' && (e as { reason?: string }).reason === 'user_cancel',
    );
    expect(drops.length).toBe(1);
  });
});
