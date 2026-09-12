/**
 * Scenario: a heal whose lineage cannot be rebuilt stands down, and takes
 * nothing with it.
 *
 * A replacement replays the original's record onto a fresh fork. A record
 * with a media-bearing tool result resolves its bytes through the run's
 * attachment store at pricing time, and `materialize` throws — by design —
 * for content that is gone or has drifted. That throw used to escape the
 * ladder: the fork had already been made (a leaked lease, invisible to
 * teardown), and the error closed the whole pool partial for a heal that was
 * best-effort to begin with.
 *
 * The shape: one agent whose first image call lands and whose second is
 * poisoned; between the two the store loses the blob.
 *
 * What this locks: the lineage is priced before any fork exists, a heal that
 * cannot be forged is no heal — the original's `agent:failed` stands, no
 * `pool:agentHeal`, no second fork announced — and the run closes normally
 * with nothing but the root alive (I42).
 */
import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import type { Tool } from '../../../src/Tool';
import { runPool, STOP } from '../harness';
import { MediaTool, PNG_BYTES, MEDIA_TEST_NCTX, mediaFailures } from '../../helpers/media';
import { MemoryAttachmentStore } from '../../helpers/memory-store';
import { I42_noLeakedBranches, formatResult } from '../predicates';

/** A store that can lose everything it holds — bit rot in one flag. */
class LosingStore extends MemoryAttachmentStore {
  lost = false;
  override get(digest: string): Uint8Array | null { return this.lost ? null : super.get(digest); }
}

const policy: AgentPolicy = {
  onProduced: (_a, parsed) => parsed.toolCalls.length > 0
    ? { type: 'tool_call', tc: parsed.toolCalls[0] }
    : { type: 'idle', reason: 'free_text_stop' },
  onRecovery: () => ({ type: 'skip' }),
  shouldExit: () => false,
};

describe('scenario: a heal whose lineage is gone stands down', () => {
  it('no fork, no heal, the original\'s failure stands, the run closes', async () => {
    const store = new LosingStore();
    const run = await runPool({
      nCtx: MEDIA_TEST_NCTX, cellsUsed: 0,
      captureError: true,
      attachments: store,
      scripts: [{ tokens: [1, STOP], toolCall: { name: 'rasterize', arguments: '{}' } }],
      tools: new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]),
      policy,
      instrument: (ctx) => {
        let calls = 0;
        const innerMM = ctx._storePrefillMultimodal.bind(ctx);
        ctx._storePrefillMultimodal = async (handles, sep, prompts, bitmaps) => {
          if (++calls === 2) {
            // The second image is poisoned, and the store has lost the first.
            ctx.mockMultimodalError = () => ({ message: 'compute failed', rc: -3, partial: false });
            store.lost = true;
          }
          return innerMM(handles, sep, prompts, bitmaps);
        };
      },
    });

    expect(mediaFailures(run.channelEvents), 'the second image prefill must have been poisoned').toHaveLength(1);
    const original = (mediaFailures(run.channelEvents)[0] as { agentId: number }).agentId;
    expect(run.error, `the pool threw: ${String((run.error as Error)?.message ?? run.error)}`).toBeUndefined();
    expect(run.traceEvents.some(e => e.type === 'pool:close'), 'the run was torn down, not completed').toBe(true);

    // No heal, and no fork announced for one.
    expect(run.traceEvents.some(e => e.type === 'pool:agentHeal')).toBe(false);
    const creates = run.traceEvents.filter(e => e.type === 'branch:create' && (e as { role?: string }).role === 'agentFork');
    expect(creates.map(c => (c as { branchHandle: number }).branchHandle)).toEqual([original]);
    // The original's failure is its one terminal event.
    expect(run.channelEvents.filter(e => e.type === 'agent:failed' && (e as { agentId: number }).agentId === original)).toHaveLength(1);
    expect(formatResult('I42', I42_noLeakedBranches(run))).toBe('I42: ok');
  });
});
