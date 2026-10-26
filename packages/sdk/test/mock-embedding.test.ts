/**
 * The mock embeds a multimodal input the way the kernel does: only on an
 * embedding context with a projector, framing the input with the model's own
 * special tokens, and refusing, with nothing run, an input larger than one
 * dispatch.
 */
import { describe, it, expect } from 'vitest';
import { MockSessionContext } from '../src/testing';
import { MEDIA_MARKER } from '../src/deltas';

const image = new Uint8Array([1]);

describe('mock encodeMultimodal', () => {
  it('refuses a context that is not an embedding context with a projector, before any work', () => {
    const reasoning = new MockSessionContext();
    expect(() => reasoning.encodeMultimodal(MEDIA_MARKER, [image]))
      .toThrow('encodeMultimodal requires an embedding context with a projector; pass embeddings: true and mmprojPath to createContext');
    const blind = new MockSessionContext({ embeddings: true });
    blind.mockSupportsVision = false;
    expect(() => blind.encodeMultimodal(MEDIA_MARKER, [image])).toThrow(/requires an embedding context with a projector/);
    expect(reasoning.multimodalEncodes).toEqual([]);
  });

  it('measures an input on an embedding context with the model\'s special tokens, as it encodes it', async () => {
    const reasoning = new MockSessionContext();
    const embedding = new MockSessionContext({ embeddings: true });
    const framed = await embedding._cellsMultimodal([], MEDIA_MARKER, [image]);
    expect(framed - await reasoning._cellsMultimodal([], MEDIA_MARKER, [image])).toBe(embedding.mockSpecialTokens);
    await embedding.encodeMultimodal(MEDIA_MARKER, [image]);
    expect(embedding.multimodalEncodes).toEqual([{ prompt: MEDIA_MARKER, inputKinds: ['image'], cells: framed }]);
  });

  it('refuses an input larger than one dispatch, with nothing run', async () => {
    const ctx = new MockSessionContext({ embeddings: true, nBatch: 8 });
    await expect(ctx.encodeMultimodal(MEDIA_MARKER, [image])).rejects.toThrow(/must go in one dispatch on this context, which holds 8/);
    expect(ctx.multimodalEncodes).toEqual([]);
  });
});
