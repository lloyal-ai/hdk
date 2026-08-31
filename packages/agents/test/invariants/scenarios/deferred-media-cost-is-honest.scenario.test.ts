/**
 * Scenario: a DEFERRED media item tells the policy what it actually costs.
 *
 * When SETTLE cannot admit an item it defers it, and the stall-break later
 * asks the policy what to do — nudge the agent, or drop it. That decision is
 * made from ONE number: the item's cost.
 *
 * A media item's `prefillTokens` is empty by construction: mtmd tokenizes
 * downstream, so the delta stops at the string stage and the cost lives in
 * `cells`. Reading `prefillTokens.length` therefore reports **0** — not
 * "unknown", but a confident zero — and the policy decides whether to keep an
 * agent alive on the basis that its pending result is free.
 *
 * This is what "the rail is re-derived at every use" costs when one site
 * forgets to derive it.
 */
import { describe, it, expect } from 'vitest';
import type { Agent } from '../../../src/Agent';
import type { AgentPolicy, SettleAction } from '../../../src/AgentPolicy';
import type { Tool } from '../../../src/Tool';
import { runPool } from '../harness';
import { MediaTool, PNG_BYTES, MEDIA_TEST_NCTX } from '../../helpers/media';

describe('scenario: a deferred media item reports its real cost', () => {
  it('hands the policy cells, never a confident zero', async () => {
    const costsSeen: number[] = [];
    const policy: AgentPolicy = {
      onProduced: (_a: Agent, parsed) =>
        parsed.toolCalls.length > 0
          ? { type: 'tool_call', tc: parsed.toolCalls[0] }
          : { type: 'idle', reason: 'free_text_stop' },
      shouldExit: () => false,
      onSettleReject: (_a, cost): SettleAction => {
        costsSeen.push(cost);
        return { type: 'idle', reason: 'pressure_settle_reject' };
      },
    };

    // Enough images that the item cannot be admitted at this pressure, so it
    // defers and the stall-break consults the policy.
    const images = Array.from({ length: 400 }, () => PNG_BYTES);

    await runPool({
      nCtx: MEDIA_TEST_NCTX,
      cellsUsed: MEDIA_TEST_NCTX - 2_000,
      scripts: [{ tokens: [1, 999, 999], toolCall: { name: 'rasterize', arguments: '{}' } }],
      policy,
      tools: new Map<string, Tool>([['rasterize', new MediaTool(images)]]),
    });

    expect(costsSeen.length, 'the item must have deferred for this to test anything')
      .toBeGreaterThan(0);
    expect(costsSeen,
      'the policy was told a media result costs nothing, and decided from that')
      .not.toContain(0);
  });
});
