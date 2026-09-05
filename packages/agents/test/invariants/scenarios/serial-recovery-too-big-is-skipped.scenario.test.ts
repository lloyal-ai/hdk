/**
 * Scenario: a serial recovery prompt that cannot fit is skipped, never issued.
 *
 * Serial recovery is exempt from the soft reserve — the report owns the freed
 * headroom — but not from the cache. "Ungated" used to mean ungated by
 * physical capacity too: a recovery prompt larger than what remained was
 * handed to the store, refused with rc 1, deferred three times and then
 * reported as `tool_result_failed`, which names a tool result that never
 * existed. On the embedding rail the same admission is a poison.
 *
 * What this locks: a serial recovery turn is admitted only when its cells fit
 * what physically remains after this tick's earlier admissions, minus the
 * `hardLimit` reserve its own decode needs. One that cannot fit waits while a
 * sibling can still free KV and is otherwise skipped at the stall-break —
 * `pool:recoveryFailed(recovery_skipped)`, no second `agent:done`, and no
 * prefill ever issued for it.
 */
import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';

const policy: AgentPolicy = {
  onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
  shouldExit: () => false,
  // ~3000 cells on the mock's chars/4 tokenizer: larger than the whole context.
  onRecovery: () => ({ type: 'extract', prompt: { system: 'X'.repeat(12000), user: 'report' } }),
};

describe('scenario: a serial recovery prompt that cannot fit is skipped', () => {
  it('no recovery prefill is issued; the agent fails as recovery_skipped; the run closes', async () => {
    const run = await runPool({
      nCtx: 2048, cellsUsed: 0,
      captureError: true,
      scripts: [{ tokens: [1, STOP], content: 'prose' }],
      policy,
      instrument: (ctx) => {
        // The kernel's refusal the mock lacks: no KV slot for a batch that
        // would exceed the context.
        const inner = ctx._storePrefill.bind(ctx);
        ctx._storePrefill = async (handles, tokenArrays) => {
          const cells = tokenArrays.reduce((n, t) => n + t.length, 0);
          if (ctx.cellsUsed + cells > ctx.nCtx) {
            throw Object.assign(new Error(`find_slot: no KV slot for the batch (${ctx.cellsUsed} + ${cells} > ${ctx.nCtx})`), { rc: 1 });
          }
          return inner(handles, tokenArrays);
        };
      },
    });

    expect(run.error, `the pool threw: ${String((run.error as Error)?.message ?? run.error)}`).toBeUndefined();
    expect(run.traceEvents.some(e => e.type === 'pool:close'), 'the run was torn down, not completed').toBe(true);

    const agentId = run.result.agents[0].agentId;
    // Never issued: no recovery prefill record, and the only native prefill on
    // the agent's handle is its suffix.
    expect(run.traceEvents.filter(e => e.type === 'branch:prefill' && (e as { role?: string }).role === 'recovery')).toHaveLength(0);
    expect(run.nativeCalls.filter(c => c.op === 'prefill' && c.handles.includes(agentId))).toHaveLength(1);
    // Skipped, not misreported.
    expect(run.traceEvents.some(e => e.type === 'pool:settleFailed')).toBe(false);
    const failures = run.traceEvents.filter(e => e.type === 'pool:recoveryFailed') as { agentId: number; reason: string }[];
    expect(failures.map(f => [f.agentId, f.reason])).toEqual([[agentId, 'recovery_skipped']]);
    expect(run.channelEvents.filter(e => e.type === 'agent:done')).toHaveLength(1);
    expect(run.result.agents[0].result).toBeNull();
  });
});
