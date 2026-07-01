/**
 * Invariant: a decode OOM during in-loop (parallel) recovery does NOT orphan the
 * in-flight extractor.
 *
 * The COMMIT batch where admitted reports decode can throw (KV exhausted by
 * concurrent reports). The pool then tears down — but each in-flight extractor
 * must FIRST receive a terminal `agent:failed`, else the UI spins forever on
 * "writing report". The blocking `recoverInline` path has its own `scope_error`
 * catch; this locks the same guarantee for the in-loop COMMIT path.
 */
import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';

describe('scenario: in-loop recovery decode OOM emits agent:failed (no orphan)', () => {
  it('COMMIT throw while an extractor is mid-report → agent:failed for it, then propagate', async () => {
    const policy: AgentPolicy = {
      recoveryShape: 'parallel',
      pressureThresholds: { softLimit: 20, hardLimit: 512 },
      onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
      onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      onRecovery: () => ({ type: 'extract', prompt: { system: 's', user: 'u' } }),
    };

    // Loose KV (nCtx 8000): free-text turn 1 (`1, 2, STOP`) → idle → `handleRecover`
    // (parallel) → the recovery is ADMITTED at SETTLE (fits, not deferred) → agent
    // re-activates as an in-loop extractor → its report (`3, 4, 777`) decodes in the
    // tick loop's COMMIT. The 777 sentinel makes that commit throw (mock decode OOM)
    // while the agent is `extracting` + `active`.
    const run = await runPool({
      nCtx: 8000,
      cellsUsed: 0,
      scripts: [{ tokens: [1, 2, STOP, 3, 4, 777, STOP] }],
      policy,
      terminalToolName: 'report',
      instrument: (ctx) => { ctx.throwOnCommitToken = 777; },
      captureError: true, // the decode OOM is swallowed by the pool scope; keep the run inspectable
    });

    // The in-flight extractor got a terminal `agent:failed` (reason `scope_error`) at the
    // failing COMMIT — the pool scope then swallows the decode error and closes gracefully,
    // but the extractor is NOT orphaned mid-report (which the UI renders as a stuck spinner).
    // Without the COMMIT guard, the decode error unwinds with no terminal event for it.
    const failed = run.channelEvents.filter(e => e.type === 'agent:failed');
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(String((failed[0] as { reason: string }).reason)).toMatch(/scope_error/);
    // No `agent:recovered` for it — the report never completed (the decode threw first).
    expect(run.channelEvents.some(e => e.type === 'agent:recovered')).toBe(false);
  });
});
