import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MEDIA_MARKER, PoolingType, deltaCells } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';
import { createLocalContext, nativeRepo } from './local-native';

const fixtures = resolve(nativeRepo, 'liblloyal/tests/fixtures');
const models = resolve(nativeRepo, 'models/embeddinggemma-2');
const reference: { dimension: number; entries: { name: string; kind: string; image?: string; vector: number[] }[] } =
  JSON.parse(readFileSync(resolve(fixtures, 'embedding/embeddinggemma2-reference.json'), 'utf8'));
const cat = reference.entries.find(e => e.kind === 'image' && e.image === 'cat.jpg')!;
const image = readFileSync(resolve(fixtures, cat.image!));
const contexts: SessionContext[] = [];

/** An EmbeddingGemma 2 context with its projector, whose one dispatch holds `nBatch` entries. */
async function embeddingContext(nBatch: number): Promise<SessionContext> {
  const ctx = await createLocalContext({
    modelPath: process.env.LLAMA_EMBED_MM_MODEL ?? resolve(models, 'embeddinggemma-2-Q8_0.gguf'),
    mmprojPath: process.env.LLAMA_EMBED_MM_MMPROJ ?? resolve(models, 'mmproj-BF16.gguf'),
    nCtx: nBatch, nBatch, nThreads: 4, embeddings: true, poolingType: PoolingType.MEAN,
  });
  contexts.push(ctx);
  return ctx;
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => Array.from(a).reduce((sum, v, i) => sum + v * b[i], 0);
const cosine = (a: ArrayLike<number>, b: ArrayLike<number>) => dot(a, b) / Math.sqrt(dot(a, a) * dot(b, b));

let ctx: SessionContext;
before(async () => { ctx = await embeddingContext(8192); });
after(() => contexts.forEach(c => c.dispose()));

test('an image embeds through the SDK where llama.cpp puts it, at the model\'s output width', async () => {
  assert.equal(ctx.getEmbeddingDimension(), reference.dimension);
  await ctx.kvCacheClear();
  await ctx.encodeMultimodal(MEDIA_MARKER, [image]);
  const vector = ctx.getEmbeddings(true);
  assert.equal(vector.length, reference.dimension);
  assert.ok(cosine(vector, cat.vector) >= 0.999, `cosine ${cosine(vector, cat.vector)}`);
});

test('the measure is what one dispatch admits: one short refuses with nothing run, exactly enough embeds', async () => {
  const cells = await deltaCells(ctx, { sep: [], prompt: MEDIA_MARKER, bitmaps: [image] });
  const short = await embeddingContext(cells - 1);
  await assert.rejects(short.encodeMultimodal(MEDIA_MARKER, [image]), /must go in one dispatch/);
  const exact = await embeddingContext(cells);
  await exact.encodeMultimodal(MEDIA_MARKER, [image]);
  assert.ok(cosine(exact.getEmbeddings(true), cat.vector) >= 0.999);
});
