/**
 * Scenario: a heal is a spawn wearing a lineage — it is admitted like one.
 *
 * Every prefill the pool issues is admitted against headroom; the heal's
 * replacement suffix was the last exception, because a heal was queued as spec
 * plus records and forked and tokenized only inside the executor, at batch
 * time, where the scheduler could not see its cost. A replacement that does
 * not fit then joined the shared batch, and on the kernel a no-slot rc on that
 * batch ended the whole pool instead of the one heal.
 *
 * The shape: one agent with a long suffix (larger than the soft-limit band, so
 * "does not fit headroom" also means "would overflow the context") decodes
 * far enough to leave room for a small image but not for a second copy of
 * itself, then its image prefill is poisoned (rc −3). Its branch has a live
 * child, so the prune that would normally refund its cells is skipped and the
 * replacement must fit in what is left. The mock refuses an over-budget batch
 * the way the kernel does (rc 1).
 *
 * What this locks: the replacement is dropped with `pressure_init`, like a
 * spawn the scheduler cannot admit; the run closes normally; nothing is
 * decoded on faith.
 */
import { describe, it, expect } from 'vitest';
import type { Operation } from 'effection';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import type { PoolContext } from '../../../src/orchestrators';
import type { Tool } from '../../../src/Tool';
import { runPool, STOP } from '../harness';
import { MediaTool, PNG_BYTES, mediaFailures } from '../../helpers/media';

const policy: AgentPolicy = {
  onProduced: (_a, parsed) => parsed.toolCalls.length > 0
    ? { type: 'tool_call', tc: parsed.toolCalls[0] }
    : { type: 'idle', reason: 'free_text_stop' },
  onRecovery: () => ({ type: 'skip' }),
  shouldExit: () => false,
};

describe('scenario: a heal is admitted by fit', () => {
  it('a replacement whose suffix cannot fit is dropped, not batched on faith', async () => {
    // Calibrated on the mock: root 4 cells, softLimit 1024, one mock image
    // ≈ 40 cells. The suffix below is ~1525 tokens; the agent decodes 800
    // before its call, so at the poison headroom ≈ 3600 − 4 − 1525 − 800 −
    // 1024 ≈ 247: room for the image, not for a 1525-token replacement, and
    // 4 + 1525 + 800 + 1525 > 3600 overflows the context outright.
    const longSystemPrompt = 'S'.repeat(6000);
    const orchestrate = function* (ctx: PoolContext): Operation<void> {
      const a = yield* ctx.spawn({ content: 'Task 0', systemPrompt: longSystemPrompt, seed: 0 });
      yield* ctx.waitFor(a);
    };
    const run = await runPool({
      nCtx: 3600,
      cellsUsed: 0,
      captureError: true,
      scripts: [{ tokens: [...Array(800).fill(1), STOP], toolCall: { name: 'rasterize', arguments: '{}' } }],
      tools: new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]),
      policy,
      orchestrate,
      instrument: (ctx) => {
        // Poison the image prefill with a fatal rc, and give the branch a live
        // child so its cells are NOT refunded before the heal is decided.
        ctx.mockMultimodalError = () => ({ message: 'compute failed', rc: -3, partial: false });
        const innerMM = ctx._storePrefillMultimodal.bind(ctx);
        ctx._storePrefillMultimodal = async (handles, sep, prompts, bitmaps) => {
          for (const h of handles) ctx._branchFork(h);
          return innerMM(handles, sep, prompts, bitmaps);
        };
        // The kernel's refusal the mock lacks: no KV slot for an over-budget batch.
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

    // The poison happened — otherwise nothing here is tested.
    expect(mediaFailures(run.channelEvents), 'the image prefill must have been poisoned').toHaveLength(1);
    // The heal did not take the pool down.
    expect(run.error, `the pool threw: ${String((run.error as Error)?.message ?? run.error)}`).toBeUndefined();
    expect(run.traceEvents.some(e => e.type === 'pool:close'), 'the run was torn down, not completed').toBe(true);
    // The replacement was refused for pressure, like any spawn that cannot fit.
    const original = (mediaFailures(run.channelEvents)[0] as { agentId: number }).agentId;
    const drops = run.traceEvents.filter(e => e.type === 'pool:agentDrop') as { agentId: number; reason: string }[];
    expect(drops.filter(d => d.reason === 'pressure_init' && d.agentId !== original)).toHaveLength(1);
    expect(run.traceEvents.some(e => e.type === 'pool:agentHeal')).toBe(false);
  });
});
