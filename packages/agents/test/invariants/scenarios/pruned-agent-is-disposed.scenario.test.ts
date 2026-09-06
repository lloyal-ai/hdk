/**
 * Scenario: an agent whose branch the pool pruned is `disposed`.
 *
 * `AgentStatus` has the state and the lifecycle table has the edge — `idle →
 * disposed (branch pruned)` — but only a spawn the scheduler refused ever took
 * it. Every other pruned agent stayed `idle` with a branch already gone, and
 * the close-time sweep needed `!branch.disposed` beside `status === 'idle'` to
 * tell the two apart. The status is the branch's mirror; a reader should not
 * have to consult both.
 *
 * What this locks: after the pool ends, every agent the pool pruned reads
 * `disposed`, and the transition went through the table (idle → disposed).
 */
import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';

const policy: AgentPolicy = {
  onProduced: (_a, parsed) => parsed.toolCalls[0]?.name === 'report'
    ? { type: 'return', result: 'done' }
    : { type: 'idle', reason: 'free_text_stop' },
  onRecovery: () => ({ type: 'skip' }),
  shouldExit: () => false,
};

describe('scenario: a pruned agent is disposed', () => {
  it('every agent the pool pruned reads disposed at the end', async () => {
    const run = await runPool({
      nCtx: 8192, cellsUsed: 0,
      pruneOnReturn: true,
      terminalToolName: 'report',
      scripts: [
        { tokens: [1, STOP], toolCall: { name: 'report', arguments: '{"result":"done"}' } },
        { tokens: [1, 1, STOP], toolCall: { name: 'report', arguments: '{"result":"done"}' } },
      ],
      policy,
    });
    expect(run.result.agents.map(a => a.result)).toEqual(['done', 'done']);
    for (const r of run.result.agents) {
      expect(r.branch.disposed, `agent ${r.agentId}'s branch was pruned`).toBe(true);
      expect(r.agent.status, `agent ${r.agentId} must mirror its pruned branch`).toBe('disposed');
    }
  });
});
