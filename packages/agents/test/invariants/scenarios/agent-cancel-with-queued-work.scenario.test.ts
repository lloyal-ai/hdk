/**
 * Scenario: a cancel decided in a schedule vetoes THAT schedule's work for the
 * same agent.
 *
 * The scheduler decides a cancel in step 0 (the agent joins `S.drops`) but the
 * drop is enacted only in `applySchedule`, after the whole schedule is built.
 * Between the two, the agent still reads `awaiting_tool`, so an item of its
 * that fits this tick would be admitted, its due retry re-dispatched, its
 * parked tool call dispatched. The old loop never had the gap: the cancel
 * drain ran before settle and set the agent idle at once, and settle skipped
 * idle agents.
 *
 * The shape that makes the coincidence deterministic: A's tool result does not
 * fit while B and C are alive (deferred every tick; no stall-break because
 * they decode), B returns and its prune frees exactly the room A's item needs,
 * and the cancel for A — fired on B's `agent:done` — reaches the pool at the
 * very schedule that first admits A's item. Without the veto the pool prefills
 * onto A after announcing A failed, re-activates it, prunes its branch at the
 * next observe while the status stays `active`, and — because C keeps the pool
 * alive — samples the disposed branch a tick later. That throw lands in the
 * pool's outer catch, which closes the run PARTIAL: no `pool:close`, and C,
 * 200 tokens into its 400, is abandoned with no result. Measured before the
 * fix: `pool:agentDrop(user_cancel)#2 → branch:prefill#2 → tool:settle_order →
 * one tick → branch:prune#2 → branch:prune#4 → scope:close`. (With no sibling
 * left the pool closes first and only the wasted prefill shows.)
 *
 * What this locks: after `agent:failed` the pool does nothing more for that
 * agent (I41), the run closes normally (`pool:close`), and the siblings finish.
 */
import { describe, it, expect } from 'vitest';
import type { Operation } from 'effection';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { Tool } from '../../../src/Tool';
import type { JsonSchema } from '../../../src/types';
import { runPool, STOP } from '../harness';
import { I41_terminalIsLast, formatResult } from '../predicates';

/** ~600 chars → ~190 cells once wrapped as a tool-result delta. */
class Wide extends Tool<{ query: string }> {
  readonly name = 'web_search';
  readonly description = 'a result that needs room';
  readonly parameters: JsonSchema = { type: 'object', properties: { query: { type: 'string' } } };
  *execute(): Operation<unknown> { return { results: ['x'.repeat(600)] }; }
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

describe('scenario: a cancel vetoes the same schedule\'s work for that agent', () => {
  it('A\'s deferred item is dropped with A, not prefilled after A failed', async () => {
    // Calibrated on the mock: root 4 cells, suffix 28 per agent, A's result
    // 190 cells, softLimit 1024. A decodes 150 tokens before its call, so by
    // then B and C hold ~178 cells each and the item is deferred (headroom <
    // 190) until B's 228 cells are released, when it fits: 1625 ≤ nCtx < 1753.
    const run = await runPool({
      nCtx: 1700,
      cellsUsed: 0,
      pruneOnReturn: true,
      captureError: true,
      terminalToolName: 'report',
      scripts: [
        // A (#2): a long turn, one tool call, then it must never get another turn.
        { tokens: [...Array(150).fill(1), STOP], toolCall: { name: 'web_search', arguments: '{"query":"q"}' } },
        // B (#3): 200 tokens, then the terminal call → return → prune (pruneOnReturn).
        { tokens: [...Array(200).fill(1), STOP], toolCall: { name: 'report', arguments: '{"result":"done"}' } },
        // C (#4): outlives everything, so the pool cannot close early.
        { tokens: [...Array(400).fill(1), STOP], toolCall: { name: 'report', arguments: '{"result":"done"}' } },
      ],
      tools: new Map([['web_search', new Wide()]]),
      policy,
      // Fired on B's agent:done; the pool reads it at the next schedule — the
      // one at which B's prune has just freed the room for A's item.
      cancelAfter: (ev) => (ev.type === 'agent:done' && ev.agentId === 3 ? 2 : null),
    });

    expect(run.error, `the pool threw: ${String((run.error as Error)?.message ?? run.error)}`).toBeUndefined();
    expect(formatResult('I41', I41_terminalIsLast(run))).toBe('I41: ok');
    // The outer catch closes a broken run partial and silent: no pool:close,
    // no error. I33 reads the same tell.
    expect(run.traceEvents.some(e => e.type === 'pool:close'), 'the run was torn down, not completed').toBe(true);

    const failed = run.channelEvents.filter(e => e.type === 'agent:failed') as { agentId: number; reason: string }[];
    expect(failed.map(f => [f.agentId, f.reason])).toEqual([[2, 'user_cancel']]);
    expect(run.result.agents.filter(a => a.agentId !== 2).map(a => a.result)).toEqual(['done', 'done']);
  });
});
