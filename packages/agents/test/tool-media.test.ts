/**
 * `takeToolMedia` — the framework channel a tool returns images on.
 *
 * It used to delete the key in place, so what the model was told and what the
 * trace recorded were both decided by WHERE the call sat relative to them.
 * These lock the contract that replaced that: one input, two named halves,
 * and the tool's own object left alone.
 */
import { describe, it, expect } from 'vitest';
import { takeToolMedia, TOOL_MEDIA_KEY } from '../src/Tool';
import { PNG_BYTES } from './helpers/media';

describe('takeToolMedia', () => {
  it('splits the images out from what the model is told', () => {
    const { media, result } = takeToolMedia({ page: 'p1', [TOOL_MEDIA_KEY]: [PNG_BYTES] });

    expect(media).toEqual([PNG_BYTES]);
    expect(result).toEqual({ page: 'p1' });
  });

  it('leaves the tool\'s own object untouched', () => {
    // The bytes must reach neither the model's JSON nor the trace. Deleting
    // them in place made that a property of call order; this makes it a
    // property of the function.
    const returned = { page: 'p1', [TOOL_MEDIA_KEY]: [PNG_BYTES] };
    takeToolMedia(returned);

    expect(returned[TOOL_MEDIA_KEY]).toEqual([PNG_BYTES]);
  });

  it('drops entries that are not bytes, so markers and bitmaps stay in step', () => {
    const { media } = takeToolMedia({
      [TOOL_MEDIA_KEY]: [PNG_BYTES, 'not-an-image', null, PNG_BYTES],
    });

    expect(media).toHaveLength(2);
  });

  it('returns a text-only result as-is, copying nothing', () => {
    const returned = { page: 'p1' };
    const { media, result } = takeToolMedia(returned);

    expect(media).toEqual([]);
    expect(result).toBe(returned);
  });

  it('ignores results that cannot carry the channel', () => {
    for (const r of [null, undefined, 'text', 42, [PNG_BYTES]]) {
      expect(takeToolMedia(r)).toEqual({ media: [], result: r });
    }
  });
});
