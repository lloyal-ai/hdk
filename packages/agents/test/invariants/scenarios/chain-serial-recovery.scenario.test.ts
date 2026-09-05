/**
 * Scenario: a chain step reads the RECOVERED result under SERIAL recovery too.
 *
 * `chain` waits for each agent, then extends the spine with `agent.result`.
 * `waitFor` treats `idle` as final. Under cohort recovery an agent that idles
 * without reporting is parked on its recovery turn in the same step that ends
 * its span (`chain-cohort-recovery`). Under serial recovery the produce-time
 * idle chose no recovery and left the agent to the close-time sweep: the agent
 * passed through `idle`, `waitFor` resolved against `result === null`, the
 * chain skipped its extension and spawned the next step from a spine that
 * never heard the findings — and the sweep recovered the agent after every
 * dependent had already run.
 *
 * What this locks: every drop decides its recovery at the drop, in every
 * shape. With serial recovery each chain step's `spine:extend` carries the
 * recovered result, the next step spawns only after the previous one is
 * recovered, and every agent reports.
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
  recoveryShape: 'staggered',
};

describe('scenario: chain + serial recovery', () => {
  it('every step extends the spine with the RECOVERED result, and the next step waits for it', async () => {
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

    // The second step forks only after the first is recovered: its spawn
    // follows the first agent's `agent:recovered` on the bus.
    const types = run.channelEvents.map(e => e.type);
    const firstRecovered = types.indexOf('agent:recovered');
    const secondSpawn = types.indexOf('agent:spawn', types.indexOf('agent:spawn') + 1);
    expect(firstRecovered).toBeGreaterThanOrEqual(0);
    expect(secondSpawn, 'step two spawned before step one was recovered').toBeGreaterThan(firstRecovered);
  });
});
