/**
 * Scenario: a tool returns images, the ingress refuses, and ONLY that agent dies.
 *
 * This is the first media scenario in the invariants layer, and it exists
 * because the layer had none: 27 scenarios and 9 predicates, not one of them
 * touching attachments, ingress or bitmaps.
 *
 * It also could not have been written before the harness installed the media
 * contexts. Without them `Ingress` fell back to `NoContentIngress`, every media
 * path rejected, and the throw unwound to the tick loop's own catch — which
 * closes with a partial result and NO error. A scenario written against that
 * would have passed while proving nothing.
 *
 * What this locks (I33): an agent that was live when its sibling's ingress
 * failed goes on to reach a terminal event, and the pool closes normally. The
 * failure is the agent's, not the run's.
 */
import { describe, it, expect } from 'vitest';
import type { Agent } from '../../../src/Agent';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import type { Tool } from '../../../src/Tool';
import { runPool } from '../harness';
import { I33_agentFailureIsIsolated } from '../predicates';
import { formatResult } from '../predicates';
import { MediaTool, PNG_BYTES, MEDIA_TEST_NCTX } from '../../helpers/media';

describe('scenario: a refused media ingress fails one agent, not the run', () => {
  it('the live sibling still reaches a terminal event and the pool closes', async () => {
    const policy: AgentPolicy = {
      onProduced: (_a: Agent, parsed) =>
        parsed.toolCalls.length > 0
          ? { type: 'tool_call', tc: parsed.toolCalls[0] }
          : { type: 'idle', reason: 'free_text_stop' },
      shouldExit: () => false,
    };
    const tools = new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]);

    const run = await runPool({
      nCtx: MEDIA_TEST_NCTX,
      // Two agents, both calling the media tool: the cohort has a sibling to
      // lose. One agent could not distinguish isolation from teardown.
      scripts: [
        { tokens: [1, 999, 999], toolCall: { name: 'rasterize', arguments: '{}' } },
        { tokens: [1, 999, 999], toolCall: { name: 'rasterize', arguments: '{}' } },
      ],
      policy,
      tools,
      // The barrier refuses — stands in for a normalization or commit failure,
      // before admission and before any KV moves.
      ingress: { ingest: () => Promise.reject(new Error('ingress refused')) },
    });

    const r = I33_agentFailureIsIsolated(run);
    expect(r.ok, formatResult('I33', r)).toBe(true);
  });
});
