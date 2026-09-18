/**
 * Scenario: an agent DISCARDED on the embedding rail is not force-recovered.
 *
 * Two sets model "this agent is discarded" and they are not the same set:
 *
 * - `cancelledIds` — pool-lifetime, written ONLY on a user cancel. Guards the
 *   termination sweep and DRAIN. (Now `discardedIds`, written by all three
 *   discard paths — the fix this scenario locks.)
 * - `poisoned` — local to ONE settle() call, written when a media prefill
 *   fails. Guards re-activation inside that tick only.
 *
 * Both do the identical three things at the point of discard — terminal
 * `agent:failed`, `safePrune`, `transition('idle')` — but only the first is
 * remembered past the tick. The gap is reachable because `safePrune` is a
 * documented NO-OP on a branch with live children, so a poisoned agent that
 * sub-spawned keeps `branch.disposed === false` and satisfies every condition
 * the sweep tests: idle, no result, branch alive, not in the discarded set.
 *
 * The contract this locks: a branch the runtime called POISONED is never
 * resumed. `decode_segments` is not atomic and partial-range KV ops are
 * meaningless on recurrent layers, so recovery reads from a cache whose
 * contents nothing describes.
 */
import { describe, it, expect } from 'vitest';
import type { Agent } from '../../../src/Agent';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import type { Tool } from '../../../src/Tool';
import { runPool } from '../harness';
import { MediaTool, PNG_BYTES, MEDIA_TEST_NCTX } from '../../helpers/media';

describe('scenario: a poisoned agent is never force-recovered', () => {
  const policy: AgentPolicy = {
    onProduced: (_a: Agent, parsed) =>
      parsed.toolCalls.length > 0
        ? { type: 'tool_call', tc: parsed.toolCalls[0] }
        : { type: 'idle', reason: 'free_text_stop' },
    shouldExit: () => false,
  };

  it('gets ONE terminal event, not a second from the sweep', async () => {
    const run = await runPool({
      nCtx: MEDIA_TEST_NCTX,
      scripts: [{ tokens: [1, 999, 999], toolCall: { name: 'rasterize', arguments: '{}' } }],
      policy,
      tools: new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]),
      instrument: (ctx) => {
        ctx.mockMultimodalError = () => 'decode_segments failed on image 0';
        const inner = ctx._storePrefillMultimodal.bind(ctx);
        ctx._storePrefillMultimodal = async (handles, sep, prompts, bitmaps) => {
          // A live child, so `safePrune`'s RESTRICT no-op fires and the branch
          // survives the discard. This is what a sub-spawning agent looks like
          // at the moment its media prefill fails — not a contrivance.
          for (const h of handles) ctx._branchFork(h);
          return inner(handles, sep, prompts, bitmaps);
        };
      },
    });

    const failures = run.channelEvents.filter(e => e.type === 'agent:failed');
    const media = failures.filter(e => (e as { reason?: string }).reason === 'media_prefill_failed');
    expect(media, 'the media prefill must have failed for this to test anything')
      .toHaveLength(1);
    const victim = (media[0] as { agentId: number }).agentId;

    // ONE terminal event per agent. Asserting on `branch:prefill role=recovery`
    // instead would have been vacuous: the forced recovery FAILS here, and a
    // failed recovery emits no prefill — the same shape of mistake as keying a
    // predicate off an event a torn-down run never sends.
    const forThisAgent = failures
      .filter(e => (e as { agentId: number }).agentId === victim)
      .map(e => (e as { reason?: string }).reason);

    expect(forThisAgent,
      'the pool announced this agent failed and then processed it again — a ' +
      'consumer sees two terminal events for one agent, and the second ran ' +
      'against a branch whose KV the runtime had already called unresumable')
      .toEqual(['media_prefill_failed']);
  });
});
