/**
 * Invariant: `agent:done` fires EXACTLY ONCE per agent — including on the
 * critical-kill → parallel-recovery → SETTLE-defer → stall-break path.
 *
 * Shape: a free-texting agent (recoveryShape 'parallel') crosses the hardLimit
 * → `pressure.critical` kills it in PRODUCE, emitting `agent:done` (kill). The
 * kill path calls `handleRecover`, which marks the agent `extracting` +
 * `awaiting_tool` and queues a recovery turn. Under critical, that turn's SETTLE
 * admission budget is `remaining − hardLimit < 0`, so it always DEFERS; with no
 * active siblings the stall-break drop block runs.
 *
 * The bug: the stall-break drop emits `agent:done` a SECOND time — the
 * `!a.extracting` guard sits AFTER the emit, so an already-extracting (already
 * `agent:done`'d) agent is announced done twice. `agent-pool.test.ts:288`
 * asserts `agent:done` is one-shot on the simple path; this locks it on the
 * recovery path too.
 */
import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool } from '../harness';

describe('scenario: agent:done is one-shot through defer→stall-break recovery', () => {
  it('critical kill → parallel recovery defers → stall-break does NOT re-emit agent:done', async () => {
    // shouldExit OMITTED on purpose: `policyExit ?? pressure.critical` treats an
    // explicit `false` as a veto (`false ?? x === false`), which would suppress the
    // critical kill. Absent → `undefined ?? critical` → critical governs the kill.
    // softLimit 20 (well below nCtx) so the agent is ADMITTED at spawn; hardLimit 512
    // (== nBatch floor) is the kill floor that `critical` trips.
    const policy: AgentPolicy = {
      recoveryShape: 'parallel',
      pressureThresholds: { softLimit: 20, hardLimit: 512 },
      onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
      onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      onRecovery: () => ({ type: 'extract', prompt: { system: 's', user: 'u' } }),
    };

    // nCtx 700, default hardLimit 512: after root+suffix prefill (~31) + ~158
    // committed tokens, remaining < 512 → pressure.critical fires. The agent emits
    // no terminal call (no partialToolCall) → handleRecover, not salvage. Single
    // agent → the deferred recovery reaches the stall-break with no active siblings.
    const run = await runPool({
      nCtx: 700,
      cellsUsed: 0,
      scripts: [{ tokens: [...Array.from({ length: 300 }, (_, i) => (i % 900) + 1), 999] }],
      policy,
      terminalToolName: 'report',
    });

    // Prove we exercised the critical-kill path (not a plain idle exit).
    const drops = run.traceEvents.filter(e => e.type === 'pool:agentDrop');
    expect(drops.some(d => (d as { reason?: string }).reason === 'pressure_critical')).toBe(true);

    // INVARIANT: exactly one agent:done per agent (matches agent-pool.test.ts:288).
    const doneByAgent = new Map<number, number>();
    for (const e of run.channelEvents) {
      if (e.type === 'agent:done') {
        const id = (e as { agentId: number }).agentId;
        doneByAgent.set(id, (doneByAgent.get(id) ?? 0) + 1);
      }
    }
    expect(doneByAgent.size).toBeGreaterThanOrEqual(1); // the recovery agent went through
    for (const [id, count] of doneByAgent) {
      expect(count, `agent ${id} emitted agent:done ${count}×`).toBe(1);
    }
  });
});
