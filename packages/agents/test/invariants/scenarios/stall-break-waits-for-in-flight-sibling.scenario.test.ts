/**
 * Scenario: the stall-break waits for a sibling whose tool is still in flight.
 *
 * The stall-break is the last resort for an oversized deferred item: it fires
 * when nothing in the pool can free KV, and it is terminal — a drop, or for a
 * recovery turn a skip. It used to fire on "no agent is decoding", which is
 * the naive quiescence test: an agent awaiting a fan-out tool is not decoding,
 * but its result is coming, it will decode again, and it will return and be
 * pruned. Firing then dropped a live sibling's work for want of room that was
 * about to exist.
 *
 * The shape: A's tool result is larger than the headroom while B is alive and
 * fits once B has returned and been pruned; B is awaiting a slow fan-out tool
 * when A's result arrives.
 *
 * What this locks: the stall-break does not fire while a sibling can still
 * make progress (a tool in flight, a dispatch, a parked retry, a drop or
 * finish decided this schedule, an admitted item or spawn, a decode). A's
 * result is never nudged or dropped; it lands after B's prune. And a carried
 * item does not spin the loop: while B's tool is in flight the loop naps, so
 * the pressure samples it takes in that window are bounded.
 */
import { describe, it, expect } from 'vitest';
import { sleep } from 'effection';
import type { Operation } from 'effection';
import { Tool } from '../../../src/Tool';
import type { JsonSchema } from '../../../src/types';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';

class SlowFanoutTool extends Tool<Record<string, unknown>> {
  readonly name = 'slow_search';
  readonly description = 'sleeps off the loop fiber, then returns a small result';
  readonly parameters: JsonSchema = { type: 'object', properties: {} };
  readonly fanout = true;
  *execute(): Operation<unknown> { yield* sleep(60); return { results: ['ok'] }; }
}
class BigResultTool extends Tool<Record<string, unknown>> {
  readonly name = 'web_search';
  readonly description = 'a result sized to fit only once a sibling has been pruned';
  readonly parameters: JsonSchema = { type: 'object', properties: {} };
  *execute(): Operation<unknown> { return { results: ['x'.repeat(700)] }; }
}

/** One tool call each, then an idle the policy declines to recover: the skip
 *  requests the prune, which is what frees B's cells. */
const policy: AgentPolicy = {
  onProduced: (agent, parsed) => parsed.toolCalls.length > 0 && agent.toolCallCount === 0
    ? { type: 'tool_call', tc: parsed.toolCalls[0] }
    : { type: 'idle', reason: 'free_text_stop' },
  hooks: [{ beforeAdmit: () => ({ type: 'nudge', message: 'Tool result too large. Report now.' }) }],
  shouldExit: () => false,
  onRecovery: () => ({ type: 'skip' }),
};

describe('scenario: the stall-break waits for an in-flight sibling', () => {
  it('A\'s oversized result is neither nudged nor dropped while B\'s tool runs; it lands after B is pruned; the loop naps meanwhile', async () => {
    const samples: number[] = [];
    const run = await runPool({
      // Measured on the mock: root 4, suffix 28 each, softLimit 1024. With A
      // and B alive the headroom is 202; A's result is ≈ 215 cells; B's prune
      // returns its suffix and tokens, after which the headroom is ≈ 231.
      nCtx: 1288, cellsUsed: 0,
      scripts: [
        { tokens: [1, STOP], toolCall: { name: 'web_search', arguments: '{}', id: 'a1' } },
        { tokens: [1, STOP], toolCall: { name: 'slow_search', arguments: '{}', id: 'b1' } },
      ],
      tools: new Map<string, Tool>([['web_search', new BigResultTool()], ['slow_search', new SlowFanoutTool()]]),
      policy,
      taskCount: 2,
      instrument: (ctx) => {
        const inner = ctx._storeKvPressure.bind(ctx);
        ctx._storeKvPressure = () => { samples.push(performance.now()); return inner(); };
      },
    });

    expect(run.traceEvents.some(e => e.type === 'pool:close'), 'the run was torn down, not completed').toBe(true);
    const [a, b] = run.result.agents.map(x => x.agentId);
    const trace = run.traceEvents as Array<{ type: string; ts: number; agentId?: number; branchHandle?: number; role?: string; reason?: string }>;

    // The settle policy was never consulted, the item never dropped for pressure.
    expect(trace.filter(e => e.type === 'pool:agentNudge')).toEqual([]);
    expect(trace.filter(e => e.type === 'pool:agentDrop')).toEqual([]);
    // Both agents made their one call and then ended by the skip, A's result having landed.
    expect(run.result.agents.map(x => x.toolCallCount)).toEqual([1, 1]);
    expect(trace.filter(e => e.type === 'tool:result' && e.agentId === a)).toHaveLength(1);

    // A's result landed after B's prune.
    const bPruned = trace.findIndex(e => e.type === 'branch:prune' && e.branchHandle === b);
    const aLanded = trace.findIndex(e => e.type === 'branch:prefill' && e.role === 'toolResult' && e.branchHandle === a);
    expect(bPruned, 'B was never pruned').toBeGreaterThanOrEqual(0);
    expect(aLanded, 'A\'s result never landed').toBeGreaterThan(bPruned);

    // While B's tool was in flight the loop napped: a bounded number of ticks,
    // not a spin. The window is B's dispatch to B's result on the trace clock.
    const dispatched = trace.find(e => e.type === 'tool:dispatch' && e.agentId === b)!.ts;
    const returned = trace.find(e => e.type === 'tool:result' && e.agentId === b)!.ts;
    const inWindow = samples.filter(t => t > dispatched && t < returned).length;
    expect(inWindow, `the loop sampled pressure ${inWindow} times during a 60ms tool call`).toBeLessThan(12);
  });
});
