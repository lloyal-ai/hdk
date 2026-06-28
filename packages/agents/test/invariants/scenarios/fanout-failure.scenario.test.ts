/**
 * Scenario: fan-out dispatch failure paths.
 *
 * A fan-out tool runs on a child fiber, so its failures take a different route
 * than the inline path: the child catches the throw, maps it to a `retry` or
 * `error` ToolCompletion, and DRAIN feeds it through the SAME processCompletion
 * the inline path uses. These lock the fan-out-specific halves:
 *   - ToolRetryError on a fan-out tool → parked + re-dispatched (again fan-out),
 *     then settles.
 *   - A hard error on a fan-out tool → DRAIN kills the agent with a tool_error.
 */
import { describe, it, expect } from 'vitest';
import type { Operation } from 'effection';
import { Tool, ToolRetryError } from '../../../src/Tool';
import type { JsonSchema } from '../../../src/types';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';

const policy: AgentPolicy = {
  onProduced: (agent, parsed) =>
    parsed.toolCalls.length > 0 && agent.toolCallCount === 0
      ? { type: 'tool_call', tc: parsed.toolCalls[0] }
      : { type: 'idle', reason: 'free_text_stop' },
  shouldExit: () => false,
  onRecovery: () => ({ type: 'skip' }),
};

/** Rate-limits once (ToolRetryError), then succeeds. */
class FlakyFanoutTool extends Tool<Record<string, unknown>> {
  readonly name = 'flaky';
  readonly description = 'throws ToolRetryError once, then succeeds';
  readonly parameters: JsonSchema = { type: 'object', properties: {} };
  readonly fanout = true;
  calls = 0;
  *execute(): Operation<unknown> {
    this.calls++;
    if (this.calls === 1) throw new ToolRetryError('rate limited', 5);
    return { results: ['ok'] };
  }
}

/** Throws a hard error every time. */
class ThrowingFanoutTool extends Tool<Record<string, unknown>> {
  readonly name = 'boom';
  readonly description = 'throws a hard error';
  readonly parameters: JsonSchema = { type: 'object', properties: {} };
  readonly fanout = true;
  *execute(): Operation<unknown> { throw new Error('boom'); }
}

describe('scenario: fan-out dispatch failure paths', () => {
  it('ToolRetryError on a fan-out tool → parks, re-dispatches (fan-out), then settles', async () => {
    const tool = new FlakyFanoutTool();
    const run = await runPool({
      nCtx: 4096,
      cellsUsed: 100,
      scripts: [{ tokens: [1, STOP], toolCall: { name: 'flaky', arguments: '{}', id: 'f1' } }],
      policy,
      tools: new Map<string, Tool>([['flaky', tool]]),
      maxTurns: 5,
      taskCount: 1,
    });
    const ev = run.channelEvents as any[];
    // The fan-out child mapped the throw to a retry → the agent parked.
    expect(ev.some(e => e.type === 'agent:tool_retry')).toBe(true);
    // The re-dispatched call (also fan-out) succeeded and settled.
    expect(ev.some(e => e.type === 'agent:tool_result')).toBe(true);
    expect(tool.calls).toBe(2); // threw once, succeeded on retry
  });

  it('hard error on a fan-out tool → DRAIN kills the agent with a tool_error', async () => {
    const tool = new ThrowingFanoutTool();
    const run = await runPool({
      nCtx: 4096,
      cellsUsed: 100,
      scripts: [{ tokens: [1, STOP], toolCall: { name: 'boom', arguments: '{}', id: 'b1' } }],
      policy,
      tools: new Map<string, Tool>([['boom', tool]]),
      maxTurns: 5,
      taskCount: 1,
    });
    // The fan-out child's generic-error mapping → DRAIN → processCompletion error.
    expect(run.traceEvents.some(e => e.type === 'tool:error')).toBe(true);
  });
});
