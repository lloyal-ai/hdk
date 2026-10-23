/**
 * A vector index over Matryoshka embeddings: every width the model was
 * trained to be cut to answers from one encode, a coarse scan narrows and a
 * wider rescore decides, and two vectors are only ever compared at one width.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VectorIndex } from '../src/vector-index';

const WIDTHS = [768, 512, 256, 128];

/** A deterministic vector of the full width, from a seed. */
function vector(seed: number): Float32Array {
  let s = seed;
  return Float32Array.from({ length: 768 }, () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) - 0.5);
}

describe('VectorIndex', () => {
  it('answers the closest entries first, each with its cosine at the width compared', () => {
    const index = new VectorIndex<string>({ widths: WIDTHS });
    ['a', 'b', 'c'].forEach((item, i) => index.add(item, vector(i + 1)));
    const found = index.search(vector(2), { k: 2 });
    expect(found.map(f => f.item)[0]).toBe('b');
    expect(found[0].score).toBeCloseTo(1, 5);
    expect(found).toHaveLength(2);
    // Compared at 128, the same vector is still itself: both are cut to the width and made unit length again.
    expect(index.search(vector(3), { k: 1, width: 128 })[0]).toMatchObject({ item: 'c' });
    expect(index.search(vector(3), { k: 1, width: 128 })[0].score).toBeCloseTo(1, 5);
  });

  it('keeps entries at the stored width, and refuses to compare wider than it', () => {
    const index = new VectorIndex<string>({ widths: WIDTHS, stored: 256 });
    index.add('a', vector(1));
    expect(index.search(vector(1), { k: 1 })[0].score).toBeCloseTo(1, 5);
    expect(() => index.search(vector(1), { k: 1, width: 768 })).toThrow(/stored at 256/);
  });

  it('refuses a width the model was not trained to be cut to, naming the ones it was', () => {
    expect(() => new VectorIndex({ widths: WIDTHS, stored: 300 })).toThrow(/768, 512, 256 or 128/);
    const index = new VectorIndex<string>({ widths: WIDTHS });
    index.add('a', vector(1));
    expect(() => index.search(vector(1), { k: 1, scan: { width: 64, keep: 1 } })).toThrow(/768, 512, 256 or 128/);
  });

  it('refuses a vector that is not the full width, so widths are never mixed', () => {
    const index = new VectorIndex<string>({ widths: WIDTHS });
    expect(() => index.add('short', vector(1).subarray(0, 256))).toThrow(/768/);
    expect(() => index.search(vector(1).subarray(0, 128), { k: 1 })).toThrow(/768/);
  });

  it('refuses a vector whose cut has no direction, at any width it would be compared at, so no score is undefined', () => {
    const index = new VectorIndex({ widths: WIDTHS });
    // Nonzero at full width, all zeros in its first 128 dimensions: a 128-wide cosine has no value.
    const hollow = Float32Array.from({ length: 768 }, (_, i) => (i >= 128 ? 1 : 0));
    expect(() => index.add('hollow', hollow)).toThrow(/128.*no direction/);
    expect(index.size).toBe(0);
    index.add('fine', vector(1));
    expect(() => index.search(hollow, { k: 1, scan: { width: 128, keep: 1 } })).toThrow(/128.*no direction/);
  });

  it('refuses a scan that keeps fewer entries than it is asked for, or scans wider than it rescores', () => {
    const index = new VectorIndex<string>({ widths: WIDTHS });
    index.add('a', vector(1));
    expect(() => index.search(vector(1), { k: 5, scan: { width: 128, keep: 2 } })).toThrow(/keeps 2 .* 5/);
    expect(() => index.search(vector(1), { k: 1, width: 256, scan: { width: 512, keep: 1 } })).toThrow(/narrower/);
  });
});

describe('VectorIndex on real vectors', () => {
  // EmbeddingGemma 2 vectors of a pet compilation's 615 frames, and search queries, pinned by checksum.
  const dir = join(__dirname, 'fixtures/scenario-vectors');
  const meta = JSON.parse(readFileSync(join(dir, 'cats-and-dogs.json'), 'utf8'));
  const raw = readFileSync(join(dir, meta.frames.file));

  it('reads the pinned vectors it was given', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(meta.frames.sha256);
  });

  it('answers a full scan\'s first 20 frames, in order, from a 128-wide scan keeping a quarter rescored at 768', () => {
    const frames = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    const index = new VectorIndex<number>({ widths: WIDTHS });
    meta.frames.tMs.forEach((tMs: number, i: number) => index.add(tMs, frames.subarray(i * 768, (i + 1) * 768)));
    for (const query of ['a cat', 'a dog', 'a kitten'].map(q => Float32Array.from(meta.queries[`task: search result | query: ${q}`]))) {
      const full = index.search(query, { k: 20 }).map(f => f.item);
      const coarse = index.search(query, { k: 20, scan: { width: 128, keep: Math.ceil(index.size / 4) } }).map(f => f.item);
      expect(coarse).toEqual(full);
    }
  });
});
