/**
 * Scenario: a settle-reject nudge is booked on the branch but never counted
 * as a received result (invariant I43).
 *
 * Shape: single agent, one tool call, an oversized tool result that cannot
 * fit. The policy's `onSettleReject` returns a nudge, so the pool replaces the
 * oversized result with a compact nudge payload and books it with
 * `outcome:'nudge'`. The nudge carries the ORIGINAL call's name and args, so a
 * tool (or guard) reading history by name alone would mistake it for a receipt.
 *
 * The guarantee: the nudge sits in `toolHistory`, but `attendedResults` — the
 * question "what did this agent actually receive" — excludes it. A retry is
 * therefore not blinded. (The retry LANDING and reducing to exactly one
 * received result is proven end-to-end on the media rail in `agent-pool.test.ts`;
 * here we pin the structural half in the invariant harness.)
 */
import { describe, it, expect } from 'vitest';
import { Tool } from '../../../src/Tool';
import type { Operation } from 'effection';
import type { JsonSchema } from '../../../src/types';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';
import { I43_attendedIsBooked, formatResult } from '../predicates';

class BigResultTool extends Tool<{ query: string }> {
  readonly name = 'web_search';
  readonly description = 'returns a fixed big payload';
  readonly parameters: JsonSchema = { type: 'object', properties: {} };
  // ~2000 tokens when serialized (MockSessionContext: ceil(len/4)).
  *execute(): Operation<unknown> { return { results: ['x'.repeat(8000)] }; }
}

describe('scenario: a nudge is booked but never counted as received (I43)', () => {
  it('the oversized call is booked outcome:nudge, is absent from attendedResults, and I43 holds', async () => {
    const policy = {
      onProduced: (_a: unknown, parsed: { toolCalls: unknown[] }) =>
        parsed.toolCalls.length > 0
          ? { type: 'tool_call', tc: parsed.toolCalls[0] }
          : { type: 'idle', reason: 'free_text_stop' },
      // Short so the nudge payload fits the stall headroom and actually LANDS
      // (a nudge too big to fit would drop the agent, booking nothing).
      onSettleReject: () => ({ type: 'nudge', message: 'retry' }),
      shouldExit: () => false,
      onRecovery: () => ({ type: 'skip' }),
    } as unknown as AgentPolicy;

    // Headroom (remaining 1096 − softLimit 1024 = 72) is far below the ~2000
    // token payload, so the result is settle-rejected and the policy nudges.
    const run = await runPool({
      nCtx: 4096,
      cellsUsed: 3000,
      scripts: [{ tokens: [1, STOP], toolCall: { name: 'web_search', arguments: '{"query":"t"}' } }],
      policy,
      tools: new Map<string, Tool>([['web_search', new BigResultTool()]]),
      terminalToolName: 'report',
      maxTurns: 5,
    });

    const agent = run.result.agents[0].agent;
    const web = agent.toolHistory.filter((h) => h.name === 'web_search');

    // The call was booked — as a nudge, not a result.
    expect(web.length).toBeGreaterThanOrEqual(1);
    expect(web.every((h) => h.outcome === 'nudge')).toBe(true);
    // And so it is NOT counted as something the agent received.
    expect(agent.attendedResults('web_search')).toEqual([]);
    // The structural invariant holds for the whole run.
    expect(formatResult('I43', I43_attendedIsBooked(run))).toBe('I43: ok');
  });
});
