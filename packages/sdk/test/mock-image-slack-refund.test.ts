/**
 * The mock's KV gauge must refund on prune what it charged on decode, on
 * both rails.
 *
 * On the embedding rail cells and positions diverge (an M-RoPE image adds
 * nx*ny cells but advances position by max(nx, ny)); the mock models that with
 * `mockImageCells` above `mockImagePositions`. The kernel keeps the difference
 * as per-branch embedding slack (`img_slack_own`) and `release()` returns it
 * with the position delta. A mock that refunds the position delta alone
 * leaves the slack on the gauge forever, so an invariant that reads the gauge
 * at pool end (I42) fails on every media run for a leak the pool never made.
 */
import { describe, it, expect } from 'vitest';
import { MockSessionContext } from '../src/testing';
import { MEDIA_MARKER } from '../src/deltas';

describe('mock KV gauge: the embedding rail refunds what it charged', () => {
  it('pruning a branch that decoded an image returns its image cells, not only its positions', async () => {
    const ctx = new MockSessionContext({ nCtx: 4096 });
    const root = ctx._branchCreate(0);
    await ctx._storePrefill([root], [[1, 2, 3, 4]]);
    const before = ctx.cellsUsed;

    const child = ctx._branchFork(root);
    const [r] = await ctx._storePrefillMultimodal([child], [[]], [`look ${MEDIA_MARKER}`], [[new Uint8Array([1])]]);
    expect(r.tokensDecoded, 'the mock models cells above positions on this rail').toBeGreaterThan(r.positionAdvance);
    expect(ctx.cellsUsed).toBe(before + r.tokensDecoded);

    ctx._branchPrune(child);
    expect(ctx.cellsUsed, 'the prune must return every cell the image charged').toBe(before);
  });
});
