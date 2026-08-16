/**
 * Property tests for exit-reason attribution.
 *
 * I30: the trace and the returned value agree about why an agent stopped —
 *      in both directions. A `pool:agentDrop` with a recorded reason implies
 *      a matching `AgentResult.exitReason`, and an `exitReason` implies a
 *      drop that produced it.
 *
 * Why this exists. The pool has always computed the reason and written it to
 * the trace, but `AgentResult` carried only `result`. So a caller holding a
 * report could not distinguish one the agent chose to write from one squeezed
 * out by `finishRecovery` under `pressure_critical` against a capped budget.
 * Both are non-empty strings. A `dag` dependent forking from a spine extended
 * with the second is working from a rushed conclusion and cannot know it.
 *
 * The bidirectional form is deliberate. Asserting only "every drop has a
 * reason" would pass if `exitReason` were set unconditionally, and asserting
 * only the converse would pass if it were never set at all. Drift shows up in
 * one direction or the other, so both are checked.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { Tool } from '../../src/Tool';
import type { Operation } from 'effection';
import type { JsonSchema } from '../../src/types';
import type { AgentPolicy } from '../../src/AgentPolicy';
import { runPool, STOP } from './harness';
import { I30_exitReasonMatchesTrace, formatResult } from './predicates';

class SizedTool extends Tool<{ query: string }> {
  readonly name = 'web_search';
  readonly description = 'tool with configurable result size';
  readonly parameters: JsonSchema = { type: 'object', properties: { query: { type: 'string' } } };
  constructor(private readonly _chars: number) { super(); }
  *execute(): Operation<unknown> { return { results: ['x'.repeat(this._chars)] }; }
}

const basePolicy = (over: Partial<AgentPolicy> = {}): AgentPolicy => ({
  onProduced: (_a, parsed) => {
    if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
    return { type: 'idle', reason: 'free_text_stop' };
  },
  shouldExit: () => false,
  onRecovery: () => ({ type: 'skip' }),
  ...over,
});

describe('property: exit-reason attribution', () => {
  it('I30 — trace and AgentResult agree, across the pressure range', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Result size: comfortably fitting through to oversized.
        fc.integer({ min: 100, max: 12000 }),
        // Initial pressure: low through to near-critical.
        fc.integer({ min: 1000, max: 3800 }),
        async (resultChars, cellsUsed) => {
          const run = await runPool({
            nCtx: 4096,
            cellsUsed,
            scripts: [{
              tokens: [1, STOP],
              toolCall: { name: 'web_search', arguments: '{"query":"q"}' },
            }],
            policy: basePolicy(),
            tools: new Map<string, Tool>([['web_search', new SizedTool(resultChars)]]),
            terminalToolName: 'report',
            maxTurns: 3,
          });

          const r = I30_exitReasonMatchesTrace(run);
          expect(r.ok, formatResult('I30', r)).toBe(true);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('I30 — a policy_exit is attributed on the result, not only in the trace', async () => {
    // Forces the branch that the property test only reaches incidentally: the
    // policy kills the agent outright, so `exitReason` must be 'policy_exit'
    // and must not be left undefined by a result mapper that forgot the field.
    const run = await runPool({
      nCtx: 4096,
      cellsUsed: 1000,
      scripts: [{
        tokens: [1, STOP],
        toolCall: { name: 'web_search', arguments: '{"query":"q"}' },
      }],
      policy: basePolicy({ shouldExit: () => true }),
      tools: new Map<string, Tool>([['web_search', new SizedTool(200)]]),
      terminalToolName: 'report',
      maxTurns: 3,
    });

    const drops = run.traceEvents.filter(e => e.type === 'pool:agentDrop');
    expect(drops.length, 'shouldExit:true should have dropped the agent').toBeGreaterThan(0);

    const r = I30_exitReasonMatchesTrace(run);
    expect(r.ok, formatResult('I30', r)).toBe(true);

    // And the attribution is actually present, not vacuously consistent
    // because both halves are empty.
    const attributed = run.result.agents.filter(a => a.exitReason !== undefined);
    expect(attributed.length, 'a dropped agent must carry its reason').toBeGreaterThan(0);
  });

  it('I30 — an agent that finishes on its own terms carries no exitReason', async () => {
    // The other direction: absence must mean something. If `exitReason` were
    // set unconditionally this passes nothing, so it is asserted explicitly.
    const run = await runPool({
      nCtx: 8192,
      cellsUsed: 100,
      scripts: [{ tokens: [1, STOP], content: 'done' }],
      policy: basePolicy(),
      tools: new Map<string, Tool>(),
      terminalToolName: 'report',
      maxTurns: 3,
    });

    const r = I30_exitReasonMatchesTrace(run);
    expect(r.ok, formatResult('I30', r)).toBe(true);
  });
});
