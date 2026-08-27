/**
 * Scenario: the trace tee's mirror-completeness invariant (I31).
 *
 * With a real TraceWriter active, every pool-side write of a mirrored type
 * (`pool:agentNudge`, `tool:authReject`, `pool:agentDrop`, `branch:prune`,
 * `tool:dispatch`) reaches the bus exactly once as an `agent:trace`
 * envelope wrapping the same event, attributed to the right agent. The dev
 * pane trusts the mirror to BE the file — this locks that equivalence.
 *
 * Two run shapes exercise the allowlist:
 *   - a normal tool run (tool:dispatch mirrors, prunes on return),
 *   - an oversized-result run (settle_reject nudge + drop mirrors).
 */
import { describe, it, expect } from 'vitest';
import { Tool } from '../../../src/Tool';
import type { Operation } from 'effection';
import type { JsonSchema } from '../../../src/types';
import { DefaultAgentPolicy } from '../../../src/AgentPolicy';
import { I31_traceTeeMirrors, formatResult } from '../predicates';
import { runPool, STOP } from '../harness';

class SmallTool extends Tool<{ query: string }> {
  readonly name = 'web_search';
  readonly description = 'returns a small payload';
  readonly parameters: JsonSchema = { type: 'object', properties: { query: { type: 'string' } } };
  *execute(): Operation<unknown> { return { results: ['ok'] }; }
}

class BigResultTool extends Tool<{ query: string }> {
  readonly name = 'web_search';
  readonly description = 'returns a fixed big payload';
  readonly parameters: JsonSchema = { type: 'object', properties: { query: { type: 'string' } } };
  *execute(): Operation<unknown> { return { results: ['x'.repeat(8000)] }; }
}

describe('scenario: trace-tee mirror completeness (I31)', () => {
  it('a tool run mirrors every allowlisted pool write, attributed', async () => {
    const run = await runPool({
      nCtx: 16384,
      cellsUsed: 1000,
      scripts: [{
        tokens: [1, STOP],
        toolCall: { name: 'web_search', arguments: '{"query":"q"}' },
      }],
      policy: new DefaultAgentPolicy({ terminalToolName: 'report' }),
      tools: new Map<string, Tool>([['web_search', new SmallTool()]]),
      terminalToolName: 'report',
      maxTurns: 5,
      trace: true,
    });

    // The dispatch itself is on the allowlist — at least one mirror exists.
    expect(run.channelEvents.some(e => e.type === 'agent:trace')).toBe(true);
    const r = I31_traceTeeMirrors(run);
    expect(r.ok, formatResult('I31', r)).toBe(true);
  });

  it('an oversized-result run mirrors the nudge and drop writes too', async () => {
    const run = await runPool({
      nCtx: 4096,
      cellsUsed: 3000,
      scripts: [{
        tokens: [1, STOP],
        toolCall: { name: 'web_search', arguments: '{"query":"q"}' },
      }],
      policy: new DefaultAgentPolicy({
        terminalToolName: 'report',
        budget: { context: { softLimit: 1024, hardLimit: 512 } },
      }),
      tools: new Map<string, Tool>([['web_search', new BigResultTool()]]),
      terminalToolName: 'report',
      maxTurns: 5,
      trace: true,
    });

    const r = I31_traceTeeMirrors(run);
    expect(r.ok, formatResult('I31', r)).toBe(true);
  });
});
