/**
 * The embedder against real weights — nomic-embed-text v1.5, the native runtime's own fixture. Skipped
 * without them. What a unit test with a fake context cannot show: that the vectors mean something, that
 * concurrent callers get exactly the vectors sequence gives, and that the model's pooling is what runs.
 */
import { describe, it, expect } from 'vitest';
import { call, run, scoped, spawn } from 'effection';
import { createEmbedder } from '../src/providers/embedding';
import { NOMIC_MODEL_PATH } from './helpers/embed-model';

const describeWithModel = NOMIC_MODEL_PATH ? describe : describe.skip;

const cosine = (a: Float32Array, b: Float32Array): number => a.reduce((s, x, i) => s + x * b[i], 0);

describeWithModel('createEmbedder over nomic-embed-text v1.5', () => {
  const texts = [
    'search_query: how does a branch inherit the KV cache of its parent',
    'search_document: A child branch is forked at the token where it diverges and attends over everything its parent already attended over.',
    'search_document: Preheat the oven to 220 degrees and roast the vegetables for forty minutes.',
  ];

  it('answers unit vectors of the model\'s dimension, and the related pair is closer than the unrelated one', async () => {
    await run(function* () {
      const e = yield* createEmbedder(NOMIC_MODEL_PATH!, { nCtx: 512, pooling: 'mean' });
      expect(e.dimension).toBe(768);
      const [q, related, unrelated] = yield* e.embed(texts);
      for (const v of [q, related, unrelated]) {
        expect(v).toHaveLength(768);
        expect(cosine(v, v)).toBeCloseTo(1, 3);
      }
      expect(cosine(q, related)).toBeGreaterThan(cosine(q, unrelated));
    });
  }, 60_000);

  it('concurrent callers get exactly the vectors sequence gives', async () => {
    await run(function* () {
      const e = yield* createEmbedder(NOMIC_MODEL_PATH!, { nCtx: 512, pooling: 'mean' });
      const serial = yield* e.embed(texts);
      const [a, b, c] = yield* scoped(function* () {
        const t0 = yield* spawn(() => e.embed([texts[0]]));
        const t1 = yield* spawn(() => e.embed([texts[1]]));
        const t2 = yield* spawn(() => e.embed([texts[2]]));
        return [yield* t0, yield* t1, yield* t2];
      });
      for (const [got, want] of [[a[0], serial[0]], [b[0], serial[1]], [c[0], serial[2]]] as const) {
        expect(cosine(got, want)).toBeCloseTo(1, 5);
      }
    });
  }, 60_000);

  it('a text past the context is refused, and the next call answers normally', async () => {
    await run(function* () {
      const e = yield* createEmbedder(NOMIC_MODEL_PATH!, { nCtx: 32, pooling: 'mean' });
      let refused: unknown;
      try { yield* e.embed([texts[1] + ' ' + texts[1] + ' ' + texts[1]]); } catch (err) { refused = err; }
      expect(String(refused)).toMatch(/`model\.embedding\.context` is 32/);
      const [v] = yield* e.embed(['search_query: a short one']);
      expect(v).toHaveLength(768);
    });
  }, 60_000);

  it('the pooling is the model\'s, not the runtime\'s default: last-token pooling answers different vectors', async () => {
    const mean = await run(function* () {
      const e = yield* createEmbedder(NOMIC_MODEL_PATH!, { nCtx: 512, pooling: 'mean' });
      return yield* e.embed([texts[1]]);
    });
    const last = await run(function* () {
      const e = yield* createEmbedder(NOMIC_MODEL_PATH!, { nCtx: 512, pooling: 'last' });
      return yield* e.embed([texts[1]]);
    });
    expect(cosine(mean[0], last[0])).toBeLessThan(0.999);
  }, 90_000);
});
