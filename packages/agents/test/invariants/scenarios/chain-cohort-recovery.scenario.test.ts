/**
 * Scenario: a chain step reads the RECOVERED result, never an empty one.
 *
 * `chain` waits for each agent, then extends the spine with `agent.result`.
 * When the agent idles without reporting and recovery is cohort-shaped, the
 * recovery turn is queued in the same step that ends the agent's span. The
 * agent must be parked on that turn BEFORE anything else happens: if it passed
 * through `idle` on the way, `waitFor` would resolve against `result === null`,
 * the chain would skip its extension, and the next step would fork from a spine
 * that never heard the findings.
 *
 * What this locks: with cohort recovery, every chain step's `spine:extend`
 * carries the recovered result, and every agent reports.
 */
import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP, chain } from '../harness';

const REPORT_CALL = { name: 'report', arguments: '{"result":"recovered"}' };

const policy: AgentPolicy = {
  onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
  onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
  onRecovery: () => ({ type: 'extract', prompt: { system: 's', user: 'u' } }),
  shouldExit: () => false,
  recoveryShape: 'parallel',
};

describe('scenario: chain + cohort recovery', () => {
  it('every step extends the spine with the RECOVERED result', async () => {
    // Each agent: one token, STOP (idle, no result) → recovery turn → one token,
    // STOP; the recovery output parses to the terminal call.
    const script = { tokens: [1, STOP, 1, STOP], content: 'prose', toolCall: REPORT_CALL };
    const run = await runPool({
      nCtx: 8192, cellsUsed: 0,
      terminalToolName: 'report',
      scripts: [script, script],
      orchestrate: chain([0, 1], (i) => ({
        task: { content: `Task ${i}`, systemPrompt: 'You are an agent.', seed: i },
        userContent: `Task ${i}`,
      })),
      policy,
    });

    const extended = run.traceEvents
      .filter((e): e is Extract<typeof e, { type: 'spine:extend' }> => e.type === 'spine:extend')
      .map(e => e.assistantContent);
    expect(extended, 'each step must extend with what recovery produced').toEqual(['recovered', 'recovered']);
    expect(run.channelEvents.filter(e => e.type === 'agent:recovered')).toHaveLength(2);
    expect(run.result.agents.map(a => a.result)).toEqual(['recovered', 'recovered']);
  });
});
