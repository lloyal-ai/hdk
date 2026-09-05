/**
 * Scenario: `pool:tick.activeAgents` counts the cohort AFTER the tick's
 * decisions.
 *
 * The record has two contributors — the commit landing supplies the pressure
 * reading, the interpretation of that tick's stops supplies the count — so an
 * agent that returns on the tick another agent decodes is already out of the
 * count on that tick's record.
 */
import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';

const REPORT_CALL = { name: 'report', arguments: '{"result":"done"}' };

const policy: AgentPolicy = {
  onProduced: (_a, parsed) =>
    parsed.toolCalls.length > 0
      ? { type: 'return', result: 'done' }
      : { type: 'idle', reason: 'free_text_stop' },
  shouldExit: () => false,
  onRecovery: () => ({ type: 'skip' }),
};

describe('scenario: pool:tick counts after the tick', () => {
  it('an agent that returns while its sibling decodes leaves the count on that tick', async () => {
    const run = await runPool({
      nCtx: 16384, cellsUsed: 0,
      terminalToolName: 'report',
      scripts: [
        { tokens: [1, 1, 1, STOP], content: 'x' },        // A: three commits, then stops
        { tokens: [1, STOP], toolCall: REPORT_CALL },     // B: one commit, then returns
      ],
      taskCount: 2,
      policy,
    });
    const counts = run.traceEvents
      .filter((e): e is Extract<typeof e, { type: 'pool:tick' }> => e.type === 'pool:tick')
      .map(e => e.activeAgents);
    // Tick 1: both decode. Tick 2: A decodes, B returns — B is already out.
    // Tick 3: A alone.
    expect(counts).toEqual([2, 1, 1]);
  });
});
