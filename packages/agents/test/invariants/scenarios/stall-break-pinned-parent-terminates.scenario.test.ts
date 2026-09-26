/**
 * Scenario: blocked children pin a prune-requested parent, and the pool still
 * terminates.
 *
 * The stall-break must count actionable progress, not outstanding
 * obligations. A parent whose prune is requested but that still has live
 * children cannot be reclaimed; if its pending prune counted as "KV can still
 * be freed", two children whose oversized results can never fit would wait on
 * the parent, the parent on the children, and the pool would idle forever.
 *
 * The shape: P is cancelled while its two children A and B are alive (a
 * cancelled non-leaf keeps its branch); A and B each bring back a result
 * larger than the context can ever hold.
 *
 * What this locks: with nothing in flight and nothing decoding, the
 * stall-break fires for A and B despite P's pending prune; they are dropped,
 * pruned, P becomes a leaf and is pruned, and the run closes with nothing but
 * the root alive (I42).
 */
import { describe, it, expect } from 'vitest';
import type { Operation } from 'effection';
import { Tool } from '../../../src/Tool';
import type { JsonSchema } from '../../../src/types';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import type { PoolContext } from '../../../src/orchestrators';
import { runPool, STOP } from '../harness';
import { I42_noLeakedBranches, formatResult } from '../predicates';

class HugeResultTool extends Tool<Record<string, unknown>> {
  readonly name = 'web_search';
  readonly description = 'a result larger than the whole context';
  readonly parameters: JsonSchema = { type: 'object', properties: {} };
  *execute(): Operation<unknown> { return { results: ['x'.repeat(12000)] }; }
}

const policy: AgentPolicy = {
  onProduced: (_a, parsed) => parsed.toolCalls.length > 0
    ? { type: 'tool_call', tc: parsed.toolCalls[0] }
    : { type: 'idle', reason: 'free_text_stop' },
  hooks: [{ beforeAdmit: () => ({ type: 'drop' }) }],
  shouldExit: () => false,
  onRecovery: () => ({ type: 'skip' }),
};

describe('scenario: a pinned parent does not suppress the stall-break', () => {
  it('two children blocked on oversized results are dropped, the parent is reclaimed after them, the run closes', async () => {
    let parentId = -1;
    let spawns = 0;
    const orchestrate = function* (ctx: PoolContext): Operation<void> {
      const p = yield* ctx.spawn({ content: 'parent', systemPrompt: 'You are an agent.', seed: 0 });
      parentId = p.id;
      const a = yield* ctx.spawn({ content: 'child a', systemPrompt: 'You are an agent.', seed: 1, parent: p.branch });
      const b = yield* ctx.spawn({ content: 'child b', systemPrompt: 'You are an agent.', seed: 2, parent: p.branch });
      yield* ctx.waitFor(p); yield* ctx.waitFor(a); yield* ctx.waitFor(b);
    };
    const run = await runPool({
      nCtx: 2048, cellsUsed: 0,
      captureError: true,
      scripts: [
        { tokens: [...Array(30).fill(1), STOP], content: 'p' },                                   // P: alive long enough to be cancelled
        { tokens: [1, STOP], toolCall: { name: 'web_search', arguments: '{}', id: 'a1' } },      // A, B: one oversized result each
        { tokens: [1, STOP], toolCall: { name: 'web_search', arguments: '{}', id: 'b1' } },
      ],
      tools: new Map<string, Tool>([['web_search', new HugeResultTool()]]),
      policy,
      orchestrate,
      // Cancel P once both children exist (the third spawn on the bus): P
      // becomes a prune-requested non-leaf.
      cancelAfter: ev => ev.type === 'agent:spawn' && ++spawns === 3 ? parentId : null,
    });

    expect(run.error, `the pool threw: ${String((run.error as Error)?.message ?? run.error)}`).toBeUndefined();
    expect(run.traceEvents.some(e => e.type === 'pool:close'), 'the run did not terminate').toBe(true);
    const drops = run.traceEvents.filter(e => e.type === 'pool:agentDrop') as { agentId: number; reason: string }[];
    expect(drops.filter(d => d.reason === 'user_cancel').map(d => d.agentId)).toEqual([parentId]);
    expect(drops.filter(d => d.reason === 'pressure_settle_reject')).toHaveLength(2);
    // The parent was reclaimed after its children.
    const prunes = (run.traceEvents.filter(e => e.type === 'branch:prune') as { branchHandle: number }[]).map(e => e.branchHandle);
    expect(prunes.indexOf(parentId)).toBe(prunes.length - 1);
    expect(run.result.agents.every(a => a.agent.status === 'disposed')).toBe(true);
    expect(formatResult('I42', I42_noLeakedBranches(run))).toBe('I42: ok');
  });
});
