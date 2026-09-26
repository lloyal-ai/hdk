/**
 * Scenario: a replacement inherits the original's CALLER, not nothing.
 *
 * Two different things link an agent to what came before it. The branch parent
 * carries the ATTENTION — the KV prefix the agent reads across — and a heal has
 * always reproduced that. `Agent.parent` carries the RECEIPTS: the chain
 * `walkAncestors` climbs, and with it `attendedResults`, which is how a guard
 * asks "has this lineage already seen the answer to this call?".
 *
 * The pool reads `CallingAgent` once, when a spawn is priced, and hangs it on
 * the agent. A heal is a second spawn, forged inside the pool, and it used to be
 * forged with `caller: null` — so a replacement walked a chain one link long and
 * every receipt its lineage had already collected read as unseen. The cost is
 * not a crash: it is a healed agent re-asking what the caller already asked, and
 * a receipt-keyed guard admitting the duplicate.
 *
 * The caller here stands in for the agent whose tool opened the pool, which is
 * what a Delegate is. Nothing in the pool reads an ancestor's branch or its
 * format, so this one carries neither — only a task and one attended receipt.
 */
import { describe, it, expect } from 'vitest';
import type { Branch } from '@lloyal-labs/sdk';
import { Agent } from '../../../src/Agent';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import type { Tool } from '../../../src/Tool';
import { runPool, STOP } from '../harness';
import { MediaTool, PNG_BYTES, MEDIA_TEST_NCTX, mediaFailures } from '../../helpers/media';

const policy: AgentPolicy = {
  onProduced: (_a, parsed) => parsed.toolCalls.length > 0
    ? { type: 'tool_call', tc: parsed.toolCalls[0] }
    : { type: 'idle', reason: 'free_text_stop' },
  onRecovery: () => ({ type: 'skip' }),
  shouldExit: () => false,
};

/** The agent that was running a tool when this pool opened, with one receipt on it. */
function callerWithAReceipt(): Agent {
  const caller = new Agent({
    id: -1,
    parentId: -1,
    branch: undefined as unknown as Branch,
    fmt: {} as Agent['fmt'],
    task: 'the calling agent',
  });
  caller.recordToolResult({
    name: 'search',
    args: '{"query":"already asked"}',
    resultCells: 10,
    contextAfterPercent: 90,
    timestamp: 0,
    outcome: 'toolResult',
  });
  return caller;
}

describe('scenario: a heal carries the receipt ledger', () => {
  it('gives the replacement the original\'s caller, so the lineage still attends what the caller attended', async () => {
    const caller = callerWithAReceipt();
    // Fork order: the original (rasterizes, and the image prefill is poisoned), then its replacement.
    const run = await runPool({
      nCtx: MEDIA_TEST_NCTX,
      cellsUsed: 0,
      captureError: true,
      taskCount: 1,
      callingAgent: caller,
      scripts: [
        { tokens: [1, STOP], toolCall: { name: 'rasterize', arguments: '{}' } },
        { tokens: [1, STOP], content: 'healed' },
      ],
      tools: new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]),
      policy,
      instrument: (ctx) => {
        ctx.mockMultimodalError = () => ({ message: 'compute failed', rc: -3, partial: false });
      },
    });

    expect(mediaFailures(run.channelEvents), 'the image prefill must have been poisoned').toHaveLength(1);
    const heals = run.traceEvents.filter(e => e.type === 'pool:agentHeal') as { of: number; agentId: number }[];
    expect(heals, 'the heal was never reported, so this scenario proves nothing').toHaveLength(1);

    const original = run.result.agents.find(a => a.agentId === heals[0].of);
    const replacement = run.result.agents.find(a => a.agentId === heals[0].agentId);
    expect(original, 'the original is not on the roster').toBeDefined();
    expect(replacement, 'the replacement is not on the roster').toBeDefined();

    // The control: the original got its caller at the ordinary spawn, from the context.
    expect(original!.agent.parent, 'the original never had the caller — the scenario is not set up').toBe(caller);
    // The law: the heal is a spawn the POOL forges, and it must carry the same caller.
    expect(replacement!.agent.parent, 'the replacement was forged with no caller').toBe(caller);
    // What that chain is FOR: the receipts the lineage has already attended over.
    expect(
      replacement!.agent.attendedResults('search'),
      'the replacement would re-ask what the caller already asked',
    ).toEqual([{ query: 'already asked' }]);
  });
});
