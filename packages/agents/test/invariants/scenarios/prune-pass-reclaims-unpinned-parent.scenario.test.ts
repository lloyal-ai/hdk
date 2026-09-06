/**
 * Scenario: the prune pass reclaims a parent that its own pass just unpinned.
 *
 * The pass walked the roster forwards: a prune-requested parent with a live
 * child was skipped, the child was pruned later in the same pass, and the
 * parent — now a reclaimable leaf — was left for the next observe. Three
 * things read the pass as complete: the pressure sample taken right after it,
 * the stall-break's rule that an outstanding prune is not progress, and the
 * close. With the parent still resident, an oversized result that would fit
 * once the parent's cells returned was stalled instead.
 *
 * The shape: P idles and is prune-requested while its child C still decodes;
 * C then idles; an independent A brings back a result sized to fit only once
 * BOTH have been reclaimed. The observe that prunes C must reclaim P too.
 *
 * What this locks: the pass runs to a fixpoint — nothing reclaimable survives
 * an observe — so A's result lands with no nudge and no drop, and P's prune is
 * recorded in the same observe as C's.
 */
import { describe, it, expect } from 'vitest';
import { all } from 'effection';
import type { Operation } from 'effection';
import { Tool } from '../../../src/Tool';
import type { JsonSchema } from '../../../src/types';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import type { PoolContext } from '../../../src/orchestrators';
import { runPool, STOP } from '../harness';

class SizedResultTool extends Tool<Record<string, unknown>> {
  readonly name = 'web_search';
  readonly description = 'a result sized to fit only once parent and child are both reclaimed';
  readonly parameters: JsonSchema = { type: 'object', properties: {} };
  *execute(): Operation<unknown> { return { results: ['x'.repeat(750)] }; }
}

/** One call for A; everyone idles and is declined recovery, which requests the prune. */
const policy: AgentPolicy = {
  onProduced: (agent, parsed) => parsed.toolCalls.length > 0 && agent.toolCallCount === 0
    ? { type: 'tool_call', tc: parsed.toolCalls[0] }
    : { type: 'idle', reason: 'free_text_stop' },
  onSettleReject: () => ({ type: 'nudge', message: 'Tool result too large. Report now.' }),
  shouldExit: () => false,
  onRecovery: () => ({ type: 'skip' }),
};

describe('scenario: the prune pass reclaims a parent it just unpinned', () => {
  it('A\'s result lands with no stall; P is pruned in the same observe as C', async () => {
    const orchestrate = function* (ctx: PoolContext): Operation<void> {
      const [a, p] = yield* all([
        ctx.spawn({ content: 'A', systemPrompt: 'You are an agent.', seed: 0 }),
        ctx.spawn({ content: 'P', systemPrompt: 'You are an agent.', seed: 1 }),
      ]);
      const c = yield* ctx.spawn({ content: 'C', systemPrompt: 'You are an agent.', seed: 2, parent: p.branch });
      yield* all([ctx.waitFor(a), ctx.waitFor(p), ctx.waitFor(c)]);
    };
    const run = await runPool({
      nCtx: 1300, cellsUsed: 0,
      captureError: true,
      scripts: [
        { tokens: [1, 1, STOP], toolCall: { name: 'web_search', arguments: '{}', id: 'a1' } },   // A: result arrives once P and C are idle
        { tokens: [1, STOP] },                                                                     // P: idles first, prune-requested while C lives
        { tokens: [1, 1, STOP] },                                                                  // C: idles after P
      ],
      tools: new Map<string, Tool>([['web_search', new SizedResultTool()]]),
      policy,
      orchestrate,
    });

    expect(run.error, `the pool threw: ${String((run.error as Error)?.message ?? run.error)}`).toBeUndefined();
    expect(run.traceEvents.some(e => e.type === 'pool:close'), 'the run was torn down, not completed').toBe(true);
    const [a, p, c] = run.result.agents.map(x => x.agentId);
    const trace = run.traceEvents as Array<{ type: string; agentId?: number; branchHandle?: number; role?: string }>;

    // Never stalled.
    expect(trace.filter(e => e.type === 'pool:agentNudge')).toEqual([]);
    expect(trace.filter(e => e.type === 'pool:agentDrop')).toEqual([]);
    expect(trace.filter(e => e.type === 'branch:prefill' && e.role === 'toolResult' && e.branchHandle === a)).toHaveLength(1);

    // P and C were reclaimed in the same observe: their prune records are adjacent.
    const prunes = trace.map((e, i) => [e, i] as const).filter(([e]) => e.type === 'branch:prune');
    const iC = prunes.find(([e]) => e.branchHandle === c)![1];
    const iP = prunes.find(([e]) => e.branchHandle === p)![1];
    expect(iP, 'P was reclaimed in a later observe than C').toBe(iC + 1);
  });
});
