/**
 * Scenario: fan-out dispatch stays bounded + single-fiber under load.
 *
 * With more parallel agents than MAX_CONCURRENT_TOOLS all calling a fan-out
 * tool at once: at most the cap run concurrently; the rest queue FIFO on the
 * permit gate and run as permits free. No agent's tool is lost (anti-
 * starvation), and the single-fiber store discipline (I1) survives the burst
 * of concurrent completions draining through one SETTLE.
 */
import { describe, it, expect } from 'vitest';
import { sleep } from 'effection';
import type { Operation } from 'effection';
import { Tool } from '../../../src/Tool';
import type { JsonSchema, ToolContext } from '../../../src/types';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';
import { I1_nativeStoreSingleFiber, formatResult } from '../predicates';

// Mirrors MAX_CONCURRENT_TOOLS in agent-pool.ts (module-private there).
const CAP = 8;

/** Fan-out tool: sleeps, records peak concurrent executions + which agents ran. */
class TrackingFanoutTool extends Tool<Record<string, unknown>> {
  readonly name = 'slow';
  readonly description = 'sleeps; records peak concurrency + which agents ran';
  readonly parameters: JsonSchema = { type: 'object', properties: {} };
  readonly fanout = true;
  concurrent = 0;
  maxConcurrent = 0;
  readonly agentsRun = new Set<number>();
  constructor(private readonly ms: number) { super(); }
  *execute(_args: Record<string, unknown>, context?: ToolContext): Operation<unknown> {
    this.concurrent++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    if (context) this.agentsRun.add(context.agentId);
    yield* sleep(this.ms);
    this.concurrent--;
    return { results: ['ok'] };
  }
}

// Each agent calls the tool exactly ONCE: first stop → tool_call, any later
// stop → idle. Gating on toolCallCount keeps agents from looping the tool.
const policy: AgentPolicy = {
  onProduced: (agent, parsed) =>
    parsed.toolCalls.length > 0 && agent.toolCallCount === 0
      ? { type: 'tool_call', tc: parsed.toolCalls[0] }
      : { type: 'idle', reason: 'free_text_stop' },
  shouldExit: () => false,
  onRecovery: () => ({ type: 'skip' }),
};

describe('scenario: fan-out concurrency cap', () => {
  it('>cap agents calling a tool at once → at most cap run concurrently; all run; single-fiber holds', async () => {
    const tool = new TrackingFanoutTool(15);
    const N = 12; // > CAP
    const run = await runPool({
      nCtx: 8192,
      cellsUsed: 200, // headroom is not the constraint here — the permit gate is
      scripts: Array.from({ length: N }, () => ({
        tokens: [1, STOP],
        toolCall: { name: 'slow', arguments: '{}' },
      })),
      policy,
      tools: new Map<string, Tool>([['slow', tool]]),
      maxTurns: 5,
      taskCount: N,
    });
    // Safety: the permit gate never lets more than the cap run at once.
    expect(tool.maxConcurrent).toBeLessThanOrEqual(CAP);
    // Concurrency actually engaged (not accidentally serial).
    expect(tool.maxConcurrent).toBeGreaterThan(1);
    // Anti-starvation: every one of the N agents' tools ran (FIFO drained all).
    expect(tool.agentsRun.size).toBe(N);
    // Single-fiber store discipline survives the N concurrent completions.
    expect(formatResult('I1', I1_nativeStoreSingleFiber(run))).toBe('I1: ok');
  });
});
