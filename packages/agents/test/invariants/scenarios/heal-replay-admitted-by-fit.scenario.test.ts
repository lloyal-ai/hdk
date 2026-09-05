/**
 * Scenario: a heal is admitted for everything it will prefill — the suffix
 * AND the lineage it replays.
 *
 * The admission invariant, stated fully: every prefill a request will cause is
 * in its admitted cost. A heal's suffix was; its replay was not, and the
 * replay is the whole history of the original — every assistant turn, tool
 * result and probe — often many times the suffix. A replacement whose suffix
 * fit was created, its suffix landed, and its history was then prefilled
 * record by record on faith, into the reserve the admission had refused to
 * touch, until it either fit or a record was refused mid-way with the earlier
 * ones already landed.
 *
 * The shape: the original makes four calls with wide results (its lineage is
 * ~790 cells), then a media call that is poisoned (rc −3). Its branch has a
 * live child, so its cells are not refunded. The replacement's suffix (28) fits
 * the headroom that is left; suffix plus lineage does not.
 *
 * What this locks: the heal is refused up front (`pressure_init`, like any
 * spawn the scheduler cannot admit) — no fork announced, no prefill issued on
 * it, no `pool:agentHeal` — and the run closes normally.
 */
import { describe, it, expect } from 'vitest';
import type { Operation } from 'effection';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { Tool, TOOL_MEDIA_KEY } from '../../../src/Tool';
import type { JsonSchema } from '../../../src/types';
import { runPool, STOP } from '../harness';
import { PNG_BYTES, mediaFailures } from '../../helpers/media';

/** Four wide text results, then an image: one tool, so the harness's one
 *  scripted call per agent drives the whole history. */
class WideThenImage extends Tool<{ query: string }> {
  readonly name = 'web_search';
  readonly description = 'four wide results, then an image';
  readonly parameters: JsonSchema = { type: 'object', properties: { query: { type: 'string' } } };
  calls = 0;
  *execute(): Operation<unknown> {
    this.calls++;
    if (this.calls <= 4) return { results: ['x'.repeat(600)] };
    return { page: 'p1', [TOOL_MEDIA_KEY]: [PNG_BYTES] };
  }
}

const policy: AgentPolicy = {
  onProduced: (_a, parsed) => parsed.toolCalls.length > 0
    ? { type: 'tool_call', tc: parsed.toolCalls[0] }
    : { type: 'idle', reason: 'free_text_stop' },
  onRecovery: () => ({ type: 'skip' }),
  shouldExit: () => false,
};

describe('scenario: a heal is admitted for suffix plus lineage', () => {
  it('a replacement whose lineage cannot fit is refused before any prefill', async () => {
    // Calibrated on the mock: root 4, suffix 28, each wide result ≈ 190 cells,
    // softLimit 1024. With the original unpruned (~800 cells) headroom at the
    // heal is ≈ 2200 − 800 − 1024 ≈ 376: the suffix fits, suffix + ~790 of
    // lineage does not.
    const tool = new WideThenImage();
    const run = await runPool({
      nCtx: 2200, cellsUsed: 0,
      captureError: true,
      scripts: [{ tokens: [1, STOP], toolCall: { name: 'web_search', arguments: '{"query":"q"}' } }],
      tools: new Map([['web_search', tool]]),
      policy,
      instrument: (ctx) => {
        ctx.mockMultimodalError = () => ({ message: 'compute failed', rc: -3, partial: false });
        const innerMM = ctx._storePrefillMultimodal.bind(ctx);
        ctx._storePrefillMultimodal = async (handles, sep, prompts, bitmaps) => {
          for (const h of handles) ctx._branchFork(h);   // a live child: no refund at the prune
          return innerMM(handles, sep, prompts, bitmaps);
        };
      },
    });

    expect(mediaFailures(run.channelEvents), 'the image prefill must have been poisoned').toHaveLength(1);
    const original = (mediaFailures(run.channelEvents)[0] as { agentId: number }).agentId;
    expect(run.error, `the pool threw: ${String((run.error as Error)?.message ?? run.error)}`).toBeUndefined();
    expect(run.traceEvents.some(e => e.type === 'pool:close'), 'the run was torn down, not completed').toBe(true);

    // Refused up front, like any spawn the scheduler cannot admit.
    const drops = run.traceEvents.filter(e => e.type === 'pool:agentDrop') as { agentId: number; reason: string }[];
    expect(drops.filter(d => d.reason === 'pressure_init' && d.agentId !== original)).toHaveLength(1);
    expect(run.traceEvents.some(e => e.type === 'pool:agentHeal')).toBe(false);
    // Nothing was announced or decoded for a replacement that never entered the pool.
    const creates = run.traceEvents.filter(e => e.type === 'branch:create' && (e as { role?: string }).role === 'agentFork');
    expect(creates).toHaveLength(1);
    const foreign = run.nativeCalls.filter(c => c.op === 'prefill' && c.handles.some(h => h !== run.rootHandle && h !== original));
    expect(foreign, 'prefills were issued on a replacement the admission never priced').toHaveLength(0);
  });
});
