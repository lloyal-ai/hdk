/**
 * Scenario: fan-out dispatch — inter-agent concurrency + the intra-agent barrier.
 *
 * A `Tool.fanout` tool runs on a child fiber OFF the loop fiber, so one agent's
 * slow tool no longer parks the whole pool. This locks the two halves of the
 * target dispatch model:
 *
 *   (ii) inter-agent CONCURRENT — agent B keeps PRODUCING while agent A awaits a
 *        slow fan-out tool. This is the batched-decode moat: a tool's network
 *        I/O no longer idles the GPU for the other agents.
 *   (i)  intra-agent SERIAL — agent A does NOT sample between its tool_call and
 *        its tool_result. This is the one hard invariant (the barrier): the next
 *        token is a hypothesis refined on the settled result.
 *
 * Plus: the single-fiber store discipline (I1) still holds — fan-out moves only
 * tool.execute() off-fiber; every native store op stays on the loop fiber.
 */
import { describe, it, expect } from 'vitest';
import { sleep } from 'effection';
import type { Operation } from 'effection';
import { Tool } from '../../../src/Tool';
import type { JsonSchema } from '../../../src/types';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';
import { I1_nativeStoreSingleFiber, formatResult } from '../predicates';

/** A slow, fan-out-eligible tool: sleeps off the loop fiber, touches no ctx. */
class SlowFanoutTool extends Tool<Record<string, unknown>> {
  readonly name = 'slow_search';
  readonly description = 'sleeps, then returns a small result';
  readonly parameters: JsonSchema = { type: 'object', properties: {} };
  readonly fanout = true;
  constructor(private readonly ms: number) { super(); }
  *execute(): Operation<unknown> {
    yield* sleep(this.ms);
    return { results: ['ok'] };
  }
}

const policy: AgentPolicy = {
  onProduced: (_a, parsed) =>
    parsed.toolCalls.length > 0
      ? { type: 'tool_call', tc: parsed.toolCalls[0] }
      : { type: 'idle', reason: 'free_text_stop' },
  onSettleReject: () => ({ type: 'nudge', message: 'Report now (within 50 words).' }),
  shouldExit: () => false,
  onRecovery: () => ({ type: 'skip' }),
};

function runFanout() {
  return runPool({
    nCtx: 4096,
    cellsUsed: 100, // lots of headroom — keep pressure out of this test
    scripts: [
      // Agent A: one token, STOP → calls the slow fan-out tool. (maxTurns
      // bounds the re-call loop; we only assert on A's FIRST tool window.)
      { tokens: [1, STOP], toolCall: { name: 'slow_search', arguments: '{}', id: 'a1' } },
      // Agent B: many tokens → keeps producing across ticks while A awaits.
      { tokens: [1, 2, 3, 4, 5, 6, 7, 8, STOP] },
    ],
    policy,
    tools: new Map<string, Tool>([['slow_search', new SlowFanoutTool(20)]]),
    maxTurns: 3,
    taskCount: 2,
  });
}

/** A's first tool window in channel-event order: [tool_call .. tool_result). */
function firstToolWindow(ev: readonly any[], aId: number): { lo: number; hi: number } {
  const lo = ev.findIndex(e => e.type === 'agent:tool_call' && e.agentId === aId);
  const hi = ev.findIndex((e, i) => i > lo && e.type === 'agent:tool_result' && e.agentId === aId);
  return { lo, hi };
}

describe('scenario: fan-out dispatch concurrency', () => {
  it('(ii) inter-agent: B keeps producing while A awaits a slow fan-out tool', async () => {
    const run = await runFanout();
    const ev = run.channelEvents as any[];
    // A is whoever called the tool; B is the other agent.
    const aId = (ev.find(e => e.type === 'agent:tool_call') as any).agentId;
    const bId = run.result.agents.map(a => a.agentId).find(id => id !== aId)!;

    const { lo, hi } = firstToolWindow(ev, aId);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeGreaterThan(lo);

    // The moat: B emitted produce events WHILE A's tool was in flight. On the
    // old serial path this would be 0 (A's inline execute parked the loop).
    const bProduced = ev
      .slice(lo + 1, hi)
      .filter(e => e.type === 'agent:produce' && e.agentId === bId);
    expect(bProduced.length).toBeGreaterThan(0);
  });

  it('(i) intra-agent barrier: A does not sample between its tool_call and tool_result', async () => {
    const run = await runFanout();
    const ev = run.channelEvents as any[];
    const aId = (ev.find(e => e.type === 'agent:tool_call') as any).agentId;

    const { lo, hi } = firstToolWindow(ev, aId);
    const aProduced = ev
      .slice(lo + 1, hi)
      .filter(e => e.type === 'agent:produce' && e.agentId === aId);
    expect(aProduced.length).toBe(0);
  });

  it('single-fiber store discipline (I1) holds under fan-out', async () => {
    const run = await runFanout();
    expect(formatResult('I1', I1_nativeStoreSingleFiber(run))).toBe('I1: ok');
  });
});
