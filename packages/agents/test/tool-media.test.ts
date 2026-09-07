/**
 * `takeToolMedia` — the framework channel a tool returns images on.
 *
 * It used to delete the key in place, so what the model was told and what the
 * trace recorded were both decided by WHERE the call sat relative to them.
 * These lock the contract that replaced that: one input, two named halves,
 * and the tool's own object left alone.
 */
import { describe, it, expect } from 'vitest';
import { takeToolMedia, TOOL_ATTACHMENTS_KEY } from '../src/Tool';
import { MANIFEST_TYPE } from '@lloyal-labs/media';
import { PNG_BYTES } from './helpers/media';

describe('takeToolMedia', () => {
  it('splits the images out from what the model is told', () => {
    const { media, result } = takeToolMedia({ page: 'p1', [TOOL_ATTACHMENTS_KEY]: [PNG_BYTES] });

    expect(media).toEqual([PNG_BYTES]);
    expect(result).toEqual({ page: 'p1' });
  });

  it('leaves the tool\'s own object untouched', () => {
    // The bytes must reach neither the model's JSON nor the trace. Deleting
    // them in place made that a property of call order; this makes it a
    // property of the function.
    const returned = { page: 'p1', [TOOL_ATTACHMENTS_KEY]: [PNG_BYTES] };
    takeToolMedia(returned);

    expect(returned[TOOL_ATTACHMENTS_KEY]).toEqual([PNG_BYTES]);
  });

  it('drops entries that are not bytes, so markers and bitmaps stay in step', () => {
    const { media } = takeToolMedia({
      [TOOL_ATTACHMENTS_KEY]: [PNG_BYTES, 'not-an-image', null, PNG_BYTES],
    });

    expect(media).toHaveLength(2);
  });

  it('keeps a descriptor the store would recognise, in order with bytes, and drops one it would not', () => {
    // A tool that reads the content store returns ROOTS, not bytes: no
    // ingress, no normalizer permit, the ingest-time digest. Anything that is
    // neither bytes nor a root descriptor is not media and never was.
    const root = { digest: 'sha256:' + 'a'.repeat(64), mediaType: MANIFEST_TYPE, size: 9 };
    const { media, result } = takeToolMedia({
      page: 'p1', [TOOL_ATTACHMENTS_KEY]: [PNG_BYTES, root, { digest: 'nope' }, 'x'],
    });
    expect(media).toEqual([PNG_BYTES, root]);
    expect(result).toEqual({ page: 'p1' });
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

  it('strips a MALFORMED channel rather than serializing it', () => {
    // `_attachments: Uint8Array` (not an array of them) used to return the
    // original object — JSON-encoding every byte index onto the token rail,
    // the exact failure this helper exists to prevent. The reserved key
    // never survives; an invalid value is zero media entries.
    for (const bad of [PNG_BYTES, 'nope', 42, { 0: 1 }]) {
      const { media, result } = takeToolMedia({ page: 'p1', [TOOL_ATTACHMENTS_KEY]: bad });
      expect(media).toEqual([]);
      expect(result).toEqual({ page: 'p1' });
      expect(Object.keys(result as object)).not.toContain(TOOL_ATTACHMENTS_KEY);
    }
  });
});
