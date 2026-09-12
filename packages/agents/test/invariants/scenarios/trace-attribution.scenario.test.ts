/**
 * Scenario: trace attribution completeness (I31).
 *
 * Attribution lives in the event DATA, not an envelope: every agent-owned
 * pool write (`pool:agentNudge`, `tool:authReject`, `pool:agentDrop`,
 * `branch:prune`, `tool:dispatch`) carries its owner on the record itself,
 * and the pool bus carries NO `agent:trace` envelopes — the live mirror
 * moved to the writer boundary (rig's `useTraceWriter`, tested in rig),
 * where it attributes envelopes from exactly these stamped fields. The dev
 * pane trusts the record to name its owner — this locks that.
 *
 * Two run shapes exercise the stamped types:
 *   - a normal tool run (tool:dispatch, prunes on return),
 *   - an oversized-result run (settle_reject nudge + drop writes).
 */
import { describe, it, expect } from 'vitest';
import { Tool } from '../../../src/Tool';
import type { Operation } from 'effection';
import type { JsonSchema } from '../../../src/types';
import { DefaultAgentPolicy } from '../../../src/AgentPolicy';
import { I31_traceAttribution, formatResult } from '../predicates';
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

describe('scenario: trace attribution completeness (I31)', () => {
  it('a tool run stamps every agent-owned write; no envelopes on the pool bus', async () => {
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
    });

    // The dispatch write itself is stamped — attribution present in the file.
    const dispatch = run.traceEvents.find(e => e.type === 'tool:dispatch');
    expect(dispatch && (dispatch as { agentId?: number }).agentId).toBeGreaterThan(0);
    const r = I31_traceAttribution(run);
    expect(r.ok, formatResult('I31', r)).toBe(true);
  });

  it('an oversized-result run stamps the nudge and drop writes too', async () => {
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
    });

    const r = I31_traceAttribution(run);
    expect(r.ok, formatResult('I31', r)).toBe(true);
  });
});
