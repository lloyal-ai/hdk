/**
 * An embedding input, owned here: its parts become one delta with a marker
 * where each piece of media stands, measured and embedded in the native order,
 * and the mock refuses what the kernel refuses.
 */
import { describe, it, expect, vi } from 'vitest';
import { MockSessionContext } from '../src/testing';
import { MEDIA_MARKER, buildEmbedDelta, embedCells, embedDelta, mediaKind } from '../src/deltas';
import type { MultimodalInput } from '../src/types';

const image = new Uint8Array([1, 2, 3]);
const audio: MultimodalInput = { kind: 'audio', bytes: new Uint8Array([4, 5]) };
const video: MultimodalInput = { kind: 'video', frames: [image], timestampsMs: [0] };

describe('buildEmbedDelta', () => {
  it('places the parts in order, a marker where each piece of media stands, with no separator', () => {
    const delta = buildEmbedDelta(['a photo of ', image, ' while a voice says ', audio], { audioLimits: { maxBytes: 16, maxSamples: 16 } });
    expect(delta.sep).toEqual([]);
    expect(delta.prompt).toBe(`a photo of ${MEDIA_MARKER} while a voice says ${MEDIA_MARKER}`);
    expect(delta.bitmaps.map(mediaKind)).toEqual(['image', 'audio']);
  });

  it('owns the bytes it was given: a caller changing them afterwards changes nothing', () => {
    const bytes = new Uint8Array([9, 9]);
    const delta = buildEmbedDelta([bytes]);
    bytes[0] = 0;
    expect(delta.bitmaps[0]).toEqual(new Uint8Array([9, 9]));
  });

  it('keeps a literal marker in the text of an input with media from standing for media, and leaves text alone as written', () => {
    expect(buildEmbedDelta([`see ${MEDIA_MARKER} `, image]).prompt).toBe(`see <media> ${MEDIA_MARKER}`);
    expect(buildEmbedDelta([`see ${MEDIA_MARKER}`]).prompt).toBe(`see ${MEDIA_MARKER}`);
  });

  it('refuses sound without a byte limit, or over it, as every multimodal delta does', () => {
    expect(() => buildEmbedDelta([audio])).toThrow(/positive safe-integer byte limit/);
    expect(() => buildEmbedDelta([audio], { audioLimits: { maxBytes: 1, maxSamples: 16 } })).toThrow(/aggregate byte limit/);
  });
});

describe('embedCells and embedDelta', () => {
  const recorded = (ctx: MockSessionContext) => {
    const calls: string[] = [];
    for (const name of ['kvCacheClear', 'tokenize', 'encode', 'encodeMultimodal', 'getEmbeddings', '_cellsMultimodal'] as const) {
      const original = (ctx[name] as (...args: unknown[]) => unknown).bind(ctx);
      vi.spyOn(ctx, name).mockImplementation(((...args: unknown[]) => { calls.push(name); return original(...args); }) as never);
    }
    return calls;
  };

  it('embeds text alone through its tokens: clear, tokenize, encode, read', async () => {
    const ctx = new MockSessionContext({ embeddings: true });
    const calls = recorded(ctx);
    const vector = await embedDelta(ctx, buildEmbedDelta(['a cat']));
    expect(calls).toEqual(['kvCacheClear', 'tokenize', 'encode', 'getEmbeddings']);
    expect(vector).toBeInstanceOf(Float32Array);
  });

  it('embeds an input with media in one dispatch: clear, encode it whole, read', async () => {
    const ctx = new MockSessionContext({ embeddings: true });
    const calls = recorded(ctx);
    await embedDelta(ctx, buildEmbedDelta(['a photo of ', image]));
    expect(calls.filter((c) => c !== '_cellsMultimodal')).toEqual(['kvCacheClear', 'encodeMultimodal', 'getEmbeddings']);
    expect(ctx.multimodalEncodes.map((e) => e.prompt)).toEqual([`a photo of ${MEDIA_MARKER}`]);
  });

  it('measures text alone by its tokens, and an input with media by the projector\'s layout', async () => {
    const ctx = new MockSessionContext({ embeddings: true });
    expect(await embedCells(ctx, buildEmbedDelta(['a cat']))).toBe((await ctx.tokenize('a cat', true)).length);
    const delta = buildEmbedDelta(['a photo of ', image]);
    expect(await embedCells(ctx, delta)).toBe(await ctx._cellsMultimodal([], delta.prompt, delta.bitmaps));
  });
});

describe('the mock refuses what the kernel refuses', () => {
  it('a prompt whose markers do not match its media, measured or encoded', async () => {
    const ctx = new MockSessionContext({ embeddings: true });
    await expect(ctx._cellsMultimodal([], 'no marker', [image])).rejects.toThrow('MtmdSource - media marker count (0) does not match media count (1)');
    expect(() => ctx.encodeMultimodal(`${MEDIA_MARKER}${MEDIA_MARKER}`, [image])).toThrow('MtmdSource - media marker count (2) does not match media count (1)');
    expect(ctx.multimodalEncodes).toEqual([]);
  });
});

describe('mediaKind', () => {
  it('names what a projector input is: bare bytes are an image', () => {
    expect([image, audio, video].map(mediaKind)).toEqual(['image', 'audio', 'video']);
  });
});
