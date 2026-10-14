/**
 * The mock prices and refuses a video the way the kernel does, so a harness
 * test that attaches one sees the native layer's arithmetic and refusals.
 */
import { describe, it, expect } from 'vitest';
import { MockSessionContext } from '../src/testing';
import { MEDIA_MARKER, buildUserDeltaMultimodal, deltaCells, mediaContent } from '../src/deltas';
import type { MultimodalInput } from '../src/types';

const video = (n: number, times = Array.from({ length: n }, (_, i) => i * 250)): MultimodalInput => ({
  kind: 'video',
  frames: Array.from({ length: n }, (_, i) => new Uint8Array([i])),
  timestampsMs: times,
});

describe('mock video', () => {
  it('a video is one marker, however many frames it carries', () => {
    const parts = mediaContent('watch', [video(16)]) as Array<{ type: string }>;
    expect(parts.filter(p => p.type === 'media_marker')).toHaveLength(1);
  });

  it('fuses frames in pairs: a 16-frame clip costs the lone first frame plus eight chunks', async () => {
    const ctx = new MockSessionContext();
    const one = await ctx._cellsMultimodal([], MEDIA_MARKER, [new Uint8Array([1])]);
    const clip = await ctx._cellsMultimodal([], MEDIA_MARKER, [video(16)]);
    expect(clip - one).toBe(8 * ctx.mockImageCells);
  });

  it('prices a transcript as the text it is: a spoken clip costs more than the same frames in silence', async () => {
    const ctx = new MockSessionContext();
    const silent = video(4);
    const spoken = { ...(silent as object), notes: [{ atMs: 500, text: ' Speech: "one, two, three"' }, { atMs: 750, text: ' Speech: "four"' }] } as MultimodalInput;
    const extra = (await ctx._cellsMultimodal([], MEDIA_MARKER, [spoken])) - (await ctx._cellsMultimodal([], MEDIA_MARKER, [silent]));
    // One cell per four characters, the mock's stand-in for text.
    expect(extra).toBe(Math.ceil(' Speech: "one, two, three" Speech: "four"'.length / 4));
  });

  it('charges what it quoted and refunds it on prune', async () => {
    const ctx = new MockSessionContext();
    const delta = buildUserDeltaMultimodal(ctx, 'watch', [video(5)]);
    const quote = await deltaCells(ctx, delta);
    const h = ctx._branchCreate(0);
    const [r] = await ctx._storePrefillMultimodal([h], [delta.sep], [delta.prompt], [delta.bitmaps]);
    expect(r.tokensDecoded).toBe(quote);
    expect(r.positionAdvance).toBeLessThan(r.tokensDecoded);
    expect(ctx.multimodalPrefills[0].inputKinds[0]).toEqual(['video']);
    ctx._branchPrune(h);
    expect(ctx.cellsUsed).toBe(0);
  });

  it('refuses an invalid video per entry, before any cell is charged', async () => {
    const ctx = new MockSessionContext();
    const cases: Array<[MultimodalInput, RegExp]> = [
      [video(0), /at least one frame/],
      [{ ...(video(3) as object), timestampsMs: [0, 250] } as MultimodalInput, /one timestamp per frame/],
      [video(3, [0, 500, 250]), /timestamps must increase/],
    ];
    for (const [input, reason] of cases) {
      const h = ctx._branchCreate(0);
      const [r] = await ctx._storePrefillMultimodal([h], [[]], [MEDIA_MARKER], [[input]]);
      expect(r.error).toMatch(reason);
      expect(r.tokensDecoded).toBe(0);
      ctx._branchPrune(h);
    }
    expect(ctx.cellsUsed).toBe(0);
  });

  it('refuses to price an invalid video, as the kernel does: a quote never admits what prefill would refuse', async () => {
    const ctx = new MockSessionContext();
    for (const [input, reason] of [[video(0), /at least one frame/], [video(3, [0, 500, 250]), /timestamps must increase/]] as const) {
      await expect(deltaCells(ctx, buildUserDeltaMultimodal(ctx, '', [input]))).rejects.toThrow(reason);
    }
  });
});
