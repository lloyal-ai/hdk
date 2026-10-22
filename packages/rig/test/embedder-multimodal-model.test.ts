/**
 * The embedder over real weights: EmbeddingGemma 2 with its projector, fed
 * attachments through the content store, agrees with the vectors llama.cpp's
 * server made for the same files. Skipped without the weights.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from 'effection';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeVideo } from '@lloyal-labs/media';
import type { Attachment } from '@lloyal-labs/media';
import { createContentIngress, FileAttachmentStore } from '@lloyal-labs/media/node';
import { createEmbedder } from '../src/providers/embedding';
import type { EmbeddingInput } from '../src/retrieval';
import { EMBEDDINGGEMMA } from './helpers/embed-model';

const describeWithModel = EMBEDDINGGEMMA ? describe : describe.skip;
const cosine = (a: ArrayLike<number>, b: ArrayLike<number>) => Array.from(a).reduce((sum, x, i) => sum + x * b[i], 0);

describeWithModel('createEmbedder over EmbeddingGemma 2 and its projector', () => {
  const { model, projector, fixtures } = EMBEDDINGGEMMA!;
  const reference: Map<string, number[]> = new Map(
    JSON.parse(readFileSync(join(fixtures, 'embedding/embeddinggemma2-reference.json'), 'utf8')).entries.map((e: { name: string; vector: number[] }) => [e.name, e.vector]),
  );
  const file = (name: string) => new Uint8Array(readFileSync(join(fixtures, name)));
  let dir: string;
  let store: FileAttachmentStore;
  let cat: Attachment;
  let recording: Attachment;
  let clip: Attachment;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'embedder-gemma-'));
    store = new FileAttachmentStore(dir);
    const ingress = createContentIngress(store);
    // Stored byte for byte: the ingress would re-encode this photo (180 KB to 90 KB), and the reference read its
    // original pixels. The clip's frames and the recording pass through the ingress unchanged.
    cat = store.putAttachment({ representations: [store.putBlob(file('cat.jpg'), 'image/jpeg')] });
    recording = await ingress.ingest(file('asr-counting.wav'));
    // The clip's 16 frames, as llama.cpp's video helper samples them: four a second.
    const frames = [];
    for (let i = 0; i < 16; i++) frames.push({ root: await ingress.ingest(file(`video/frame-${String(i).padStart(2, '0')}.png`)), tMs: i * 250 });
    clip = await composeVideo(store, { frames, sampling: { fps: 4, timestampIntervalMs: 5000, maxFrames: 64 }, durationMs: 4000 });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const embedded = (inputs: EmbeddingInput[]) => run(function* () {
    const embedder = yield* createEmbedder(model, { nCtx: 8192, pooling: 'mean', projector, store });
    expect(embedder.modalities).toEqual(['text', 'image', 'video', 'audio']);
    return yield* embedder.embed(inputs);
  });

  it('embeds an image, a video and a recording from the store where llama.cpp does', async () => {
    const [image, video, sound] = await embedded([{ parts: [cat] }, { parts: [clip] }, { parts: [recording] }]);
    expect(cosine(image, reference.get('cat.jpg')!)).toBeGreaterThan(0.999);
    expect(cosine(video, reference.get('video/red-square-moves.mp4')!)).toBeGreaterThan(0.999);
    expect(cosine(sound, reference.get('asr-counting.wav')!)).toBeGreaterThan(0.999);
  }, 300_000);

  it('embeds text, an image, a video and a recording interleaved as one vector, where llama.cpp does', async () => {
    const [mixed, textAndImage] = await embedded([
      { parts: ['title: none | text: ', cat, ' beside ', clip, ' while a voice says ', recording] },
      { parts: ['title: none | text: a photo of ', cat, ' sitting on a mat'] },
    ]);
    expect(cosine(mixed, reference.get('text, image, video and audio')!)).toBeGreaterThan(0.999);
    expect(cosine(textAndImage, reference.get('text and image')!)).toBeGreaterThan(0.999);
  }, 300_000);
});
