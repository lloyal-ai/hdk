/**
 * Scenario: a heal is forged after the prune pass, when the poisoned branch's
 * lease is back in the pool.
 *
 * A replacement forks the spine, and a fork needs a sequence lease. The
 * kernel's leases are scarce (`n_seq_max`, four on a laptop scaffold) and the
 * poisoned original still holds one until the prune pass reclaims it at the
 * next observe. Forging the replacement at the failure site — inside the tick
 * that poisoned the original — asked for a lease the original had not yet
 * given back; on a full context the fork failed, and the failure escaped the
 * ladder and closed the whole pool partial.
 *
 * The shape: three agents on a four-lease context. The first's image prefill
 * is poisoned while its two siblings are still decoding, so at the poison
 * every lease is held. The mock refuses a fifth live branch the way the
 * binding does ("Failed to fork branch").
 *
 * What this locks: the ladder DECIDES the heal at the failure and the loop
 * FORGES it at the next observe, after the prune pass — once, whether or not
 * the prune freed anything — so the replacement gets the lease the original
 * returned. The heal happens (`pool:agentHeal`), the siblings are untouched,
 * and nothing but the root outlives the pool (I42).
 */
import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import type { Tool } from '../../../src/Tool';
import { runPool, STOP } from '../harness';
import { MediaTool, PNG_BYTES, MEDIA_TEST_NCTX, mediaFailures } from '../../helpers/media';
import { I42_noLeakedBranches, formatResult } from '../predicates';

const policy: AgentPolicy = {
  onProduced: (_a, parsed) => parsed.toolCalls.length > 0
    ? { type: 'tool_call', tc: parsed.toolCalls[0] }
    : { type: 'idle', reason: 'free_text_stop' },
  onRecovery: () => ({ type: 'skip' }),
  shouldExit: () => false,
};

const N_SEQ_MAX = 4;

describe('scenario: a heal is forged once the poisoned branch is reclaimed', () => {
  it('on a full four-lease context the replacement takes the lease the original gave back', async () => {
    const run = await runPool({
      nCtx: MEDIA_TEST_NCTX, cellsUsed: 0,
      captureError: true,
      taskCount: 3,
      scripts: [
        { tokens: [1, STOP], toolCall: { name: 'rasterize', arguments: '{}' } },   // the original: one image call, poisoned
        { tokens: [...Array(40).fill(1), STOP], content: 'b' },                      // siblings still decoding at the poison
        { tokens: [...Array(40).fill(1), STOP], content: 'c' },
        { tokens: [1, STOP], content: 'healed' },                                    // the replacement (fourth fork)
      ],
      tools: new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]),
      policy,
      instrument: (ctx) => {
        ctx.mockMultimodalError = () => ({ message: 'compute failed', rc: -3, partial: false });
        // The lease ceiling the mock lacks: a fifth live branch is refused.
        const innerFork = ctx._branchFork.bind(ctx);
        ctx._branchFork = (parentHandle: number, ...rest: unknown[]) => {
          if (ctx.liveHandles().length >= N_SEQ_MAX) throw new Error('Failed to fork branch');
          return (innerFork as (h: number, ...r: unknown[]) => number)(parentHandle, ...rest);
        };
      },
    });

    expect(mediaFailures(run.channelEvents), 'the image prefill must have been poisoned').toHaveLength(1);
    const original = (mediaFailures(run.channelEvents)[0] as { agentId: number }).agentId;
    expect(run.error, `the pool threw: ${String((run.error as Error)?.message ?? run.error)}`).toBeUndefined();
    expect(run.traceEvents.some(e => e.type === 'pool:close'), 'the run was torn down, not completed').toBe(true);

    // The heal happened, on the lease the original returned.
    const heals = run.traceEvents.filter(e => e.type === 'pool:agentHeal') as { of: number; agentId: number }[];
    expect(heals.map(h => h.of)).toEqual([original]);
    const pruned = run.traceEvents.findIndex(e => e.type === 'branch:prune' && (e as { branchHandle: number }).branchHandle === original);
    const forked = run.traceEvents.findIndex(e => e.type === 'branch:create' && (e as { branchHandle: number }).branchHandle === heals[0].agentId);
    expect(pruned, 'the original was never pruned').toBeGreaterThanOrEqual(0);
    expect(forked, 'the replacement was announced before the original was reclaimed').toBeGreaterThan(pruned);
    // The siblings were untouched, and nothing leaked.
    expect(run.result.agents.filter(a => a.agentId !== original && a.agentId !== heals[0].agentId)).toHaveLength(2);
    expect(formatResult('I42', I42_noLeakedBranches(run))).toBe('I42: ok');
  });
});
