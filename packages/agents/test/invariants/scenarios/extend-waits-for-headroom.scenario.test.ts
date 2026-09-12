/**
 * Scenario: an extend that does not fit waits for room; it is never handed to
 * the spine on faith.
 *
 * Every other prefill the pool issues is admitted against headroom; extends
 * were not — every pending extend joined the batch. On the kernel that is not
 * a clean failure: `decode_scatter` moves the books per chunk and throws with
 * `partial` when an earlier chunk landed, so an overflowing extend can leave
 * the spine advanced by whatever fit ("poisoned", `branch.hpp`), and the spine
 * is the one branch that cannot be pruned and replayed. The mock never refuses
 * a prefill, so this scenario refuses one the way the kernel does: rc 1, no
 * slot, when the batch would exceed nCtx.
 *
 * What this locks: an extend larger than the current headroom is carried
 * until a sibling's prune makes room, then lands — after that prune, once,
 * with the right position — and the run closes normally.
 */
import { describe, it, expect } from 'vitest';
import type { Operation } from 'effection';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import type { PoolContext } from '../../../src/orchestrators';
import { runPool, STOP } from '../harness';

const policy: AgentPolicy = {
  onProduced: (_a, parsed) => parsed.toolCalls[0]?.name === 'report'
    ? { type: 'return', result: 'done' }
    : { type: 'idle', reason: 'free_text_stop' },
  onRecovery: () => ({ type: 'skip' }),
  shouldExit: () => false,
};

describe('scenario: an extend waits for headroom', () => {
  it('lands after the prune that makes room, never as an overflowing batch', async () => {
    // Calibrated on the mock (root 4 cells, suffix 28, softLimit 1024). The
    // formatted delta below is 725 tokens. Headroom is remaining − softLimit,
    // so with nCtx 1763 the extend is short by the agent's suffix alone while
    // the agent is alive (headroom ≤ 707) and fits once the agent is pruned
    // (headroom 735). Today it is admitted at once regardless, so it lands
    // BEFORE the prune — that ordering is the red line.
    const delta = 'y'.repeat(2800);
    const orchestrate = function* (ctx: PoolContext): Operation<void> {
      const a = yield* ctx.spawn({ content: 'Task 0', systemPrompt: 'You are an agent.', seed: 0 });
      // Ask for the extension while the agent is still decoding.
      yield* ctx.extendSpine('Question', delta);
      yield* ctx.waitFor(a);
    };
    const run = await runPool({
      nCtx: 1763,
      cellsUsed: 0,
      pruneOnReturn: true,
      captureError: true,
      terminalToolName: 'report',
      scripts: [{ tokens: [...Array(300).fill(1), STOP], toolCall: { name: 'report', arguments: '{"result":"done"}' } }],
      policy,
      orchestrate,
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

    const types = run.traceEvents.map(e => e.type);
    const extends_ = run.traceEvents.filter(e => e.type === 'spine:extend') as { deltaTokens: number; positionAfter: number }[];
    expect(extends_).toHaveLength(1);
    expect(extends_[0].deltaTokens).toBeGreaterThan(0);
    // It landed after the agent's prune made room, on a spine that then held
    // root + delta.
    expect(types.indexOf('spine:extend')).toBeGreaterThan(types.indexOf('branch:prune'));
    expect(extends_[0].positionAfter).toBe(run.ctx.positionOf(run.rootHandle));
    expect(run.result.agents.map(a => a.result)).toEqual(['done']);
  });
});
