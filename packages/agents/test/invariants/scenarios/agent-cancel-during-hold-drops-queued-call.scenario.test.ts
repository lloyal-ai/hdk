/**
 * Scenario: a tool call parked before a pause, whose agent is cancelled during
 * the pause, is never dispatched after play.
 *
 * Queued work belongs to an agent in a given status. The dispatch lane holds a
 * parsed tool call from the tick it was parsed until the next schedule; a hold
 * in between keeps it there, and a cancel enacted inside the hold turns its
 * owner idle. The veto that keys on "dropped in this schedule" is empty on
 * resume, and the call went out for an agent that had already failed: the tool
 * ran, and `agent:tool_call` followed `agent:failed`. Items and retries already
 * read their owner's status; dispatches were the one lane that did not.
 *
 * Timing on the harness: a pause fired on a bus event takes hold about two
 * ticks later (the controller fiber, then the pool's watcher, each need a
 * turn). A parses its call on tick 2, so the pause is fired on tick 1's
 * `agent:tick` and the hold begins with the dispatch parked. The trace proves
 * the order: A's `agent:turn` (the parse) precedes `pool:pause`, and the cancel
 * lands inside the hold.
 *
 * What this locks: after `agent:failed` nothing more is done for the agent
 * (I41), the tool never executes, and the run closes normally.
 */
import { describe, it, expect } from 'vitest';
import type { Operation } from 'effection';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { Tool } from '../../../src/Tool';
import type { JsonSchema } from '../../../src/types';
import { runPool, STOP } from '../harness';
import { I41_terminalIsLast, formatResult } from '../predicates';

class Counting extends Tool<{ query: string }> {
  readonly name = 'web_search';
  readonly description = 'counts its executions';
  readonly parameters: JsonSchema = { type: 'object', properties: { query: { type: 'string' } } };
  executions = 0;
  *execute(): Operation<unknown> { this.executions++; return { results: ['ok'] }; }
}

const policy: AgentPolicy = {
  onProduced: (_a, parsed) => {
    const tc = parsed.toolCalls[0];
    if (!tc) return { type: 'idle', reason: 'free_text_stop' };
    return tc.name === 'report' ? { type: 'return', result: 'done' } : { type: 'tool_call', tc };
  },
  onRecovery: () => ({ type: 'skip' }),
  shouldExit: () => false,
};

describe('scenario: a cancel during a hold drops the queued call', () => {
  it('the parked tool call of an agent cancelled inside the pause is never dispatched on play', async () => {
    const tool = new Counting();
    let ticks = 0;
    const run = await runPool({
      nCtx: 8192, cellsUsed: 0,
      terminalToolName: 'report',
      scripts: [
        // A (#2): one token, STOP → its call is parked on tick 2.
        { tokens: [1, STOP], toolCall: { name: 'web_search', arguments: '{"query":"q"}' } },
        // B (#3): keeps committing, so tick 2 ends with an agent:tick on the bus.
        { tokens: [...Array(40).fill(1), STOP], toolCall: { name: 'report', arguments: '{"result":"done"}' } },
      ],
      tools: new Map([['web_search', tool]]),
      policy,
      // Fired on tick 1's agent:tick; the hold takes effect after tick 2, when
      // A's call is already parked.
      pauseAfter: (ev) => ev.type === 'agent:tick' && ++ticks === 1,
      whilePaused: async (h) => {
        h.cancel(2);
        await new Promise((r) => setTimeout(r, 40)); // let the hold tick enact it
      },
    });

    expect(run.error, `the pool threw: ${String((run.error as Error)?.message ?? run.error)}`).toBeUndefined();
    expect(run.traceEvents.some(e => e.type === 'pool:close'), 'the run was torn down, not completed').toBe(true);
    const failed = run.channelEvents.filter(e => e.type === 'agent:failed') as { agentId: number; reason: string }[];
    expect(failed.map(f => [f.agentId, f.reason])).toEqual([[2, 'user_cancel']]);
    const failedIdx = run.channelEvents.findIndex(e => e.type === 'agent:failed');
    const resumedIdx = run.channelEvents.findIndex(e => e.type === 'run:resumed');
    expect(failedIdx, 'the cancel must land inside the hold for this to test anything').toBeLessThan(resumedIdx);
    // And the call must have been parked BEFORE the hold, or the dispatch lane
    // was never exercised: A's turn (the parse) precedes the pause in the trace.
    const types = run.traceEvents.map(e => e.type + '#' + ((e as { agentId?: number }).agentId ?? ''));
    const turnIdx = types.indexOf('agent:turn#2');
    const pauseIdx = run.traceEvents.findIndex(e => e.type === 'pool:pause');
    expect(turnIdx, 'A must have parsed its call').toBeGreaterThan(-1);
    expect(turnIdx, 'the call must be parked before the hold begins').toBeLessThan(pauseIdx);
    // The call parked before the pause never went out.
    expect(tool.executions).toBe(0);
    expect(formatResult('I41', I41_terminalIsLast(run))).toBe('I41: ok');
    expect(run.result.agents.find(a => a.agentId === 3)?.result).toBe('done');
  });
});
