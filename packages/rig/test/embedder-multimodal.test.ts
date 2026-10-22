/**
 * The embedder over parts: text and attachment roots (an image, a recording,
 * a video), in order, as one input and one vector. Proven against a fake
 * native context that records what it is asked to encode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from 'effection';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeVideo } from '@lloyal-labs/media';
import type { Attachment } from '@lloyal-labs/media';
import { pcm16Wav } from '@lloyal-labs/media/client';
import { createContentIngress, FileAttachmentStore } from '@lloyal-labs/media/node';

const { createContext, fake, log } = vi.hoisted(() => {
  const log: unknown[][] = [];
  const fake = {
    projector: true,
    audio: true,
    tokenize: async (text: string) => Array.from({ length: text.length }, (_, i) => i),
    kvCacheClear: async () => {},
    encode: async (tokens: number[]) => { log.push(['encode', tokens.length]); },
    encodeMultimodal: async (prompt: string, inputs: unknown[], limits?: unknown) => { log.push(['encodeMultimodal', prompt, inputs, limits]); },
    _cellsMultimodal: async (_sep: number[], prompt: string, inputs: unknown[]) => prompt.length + 100 * inputs.length,
    getEmbeddings: () => new Float32Array([1, 0]),
    getEmbeddingDimension: () => 2,
    supportsVision: () => fake.projector,
    supportsAudio: () => fake.projector && fake.audio,
    audioSampleRate: () => 16_000,
    dispose: () => {},
  };
  return { log, fake, createContext: vi.fn(async (_opts: Record<string, unknown>) => fake) };
});
vi.mock('@lloyal-labs/sdk/node', () => ({ createContext }));
const { createEmbedder } = await import('../src/providers/embedding');

const frame = new Uint8Array(readFileSync(join(__dirname, '../../media/test/fixtures/video/frame-00.png')));
const MARKER = '<__media__>';

let dir: string;
let store: FileAttachmentStore;
let image: Attachment;
let recording: Attachment;
let video: Attachment;
beforeEach(async () => {
  log.length = 0;
  Object.assign(fake, { projector: true, audio: true });
  dir = mkdtempSync(join(tmpdir(), 'embedder-parts-'));
  store = new FileAttachmentStore(dir);
  const ingress = createContentIngress(store);
  image = await ingress.ingest(frame);
  recording = await ingress.ingest(pcm16Wav(new Float32Array(16_000).fill(0.25), 16_000));
  const frames = [await ingress.ingest(frame), await ingress.ingest(frame)].map((root, i) => ({ root, tMs: i * 250 }));
  video = await composeVideo(store, { frames, sampling: { fps: 4, timestampIntervalMs: 5000, maxFrames: 64 }, durationMs: 500 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const embedder = (projector: string | undefined = '/mmproj.gguf') =>
  createEmbedder('/e.gguf', { nCtx: 2048, pooling: 'mean', store, ...(projector ? { projector } : {}) });

describe('createEmbedder over parts', () => {
  it('embeds text and an image as one input: a marker where the image stands, encoded once', async () => {
    await run(function* () {
      yield* (yield* embedder()).embed([{ parts: ['a photo of ', image, ' on a table'] }]);
    });
    expect(log).toEqual([['encodeMultimodal', `a photo of ${MARKER} on a table`, [frame], expect.anything()]]);
  });

  it('embeds a recording as audio, admitted under media\'s default admission at the encoder\'s rate', async () => {
    await run(function* () {
      yield* (yield* embedder()).embed([{ parts: [recording] }]);
    });
    const [[, prompt, inputs, limits]] = log as [[string, string, { kind: string }[], { maxBytes: number; maxSamples: number }]];
    expect(prompt).toBe(MARKER);
    expect(inputs[0].kind).toBe('audio');
    expect(limits).toEqual({ maxBytes: 16 * 1024 * 1024, maxSamples: 16_000 * 60 + 1 });
  });

  it('embeds a video as one input on its timeline', async () => {
    await run(function* () {
      yield* (yield* embedder()).embed([{ parts: [video] }]);
    });
    const [[, prompt, inputs]] = log as [[string, string, { kind: string; timestampsMs: number[] }[]]];
    expect(prompt).toBe(MARKER);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ kind: 'video', timestampsMs: [0, 250] });
  });

  it('embeds text alone through its tokens, a bare string as one part', async () => {
    await run(function* () {
      yield* (yield* embedder()).embed(['plain text', { parts: ['more ', 'text'] }]);
    });
    expect(log).toEqual([['encode', 'plain text'.length], ['encode', 'more text'.length]]);
  });

  it('measures what each input costs, with nothing encoded', async () => {
    const cells = await run(function* () {
      return yield* (yield* embedder()).measure(['plain text', { parts: ['a photo of ', image] }]);
    });
    expect(cells).toEqual(['plain text'.length, `a photo of ${MARKER}`.length + 100]);
    expect(log).toEqual([]);
  });

  it('says what it reads: text alone without a projector; images and video with one, sound when it hears', async () => {
    const read = await run(function* () {
      const withProjector = (yield* embedder()).modalities;
      fake.audio = false;
      const sightOnly = (yield* embedder()).modalities;
      fake.projector = false;
      const textOnly = (yield* embedder(undefined)).modalities;
      return { withProjector, sightOnly, textOnly };
    });
    expect(read).toEqual({ withProjector: ['text', 'image', 'video', 'audio'], sightOnly: ['text', 'image', 'video'], textOnly: ['text'] });
  });

  it('loads its projector at the image detail it is given', async () => {
    await run(function* () {
      yield* createEmbedder('/e.gguf', { nCtx: 2048, pooling: 'mean', store, projector: '/mmproj.gguf', imageMinTokens: 70, imageMaxTokens: 280 });
    });
    expect(createContext.mock.calls.at(-1)?.[0]).toMatchObject({ mmprojPath: '/mmproj.gguf', imageMinTokens: 70, imageMaxTokens: 280 });
  });

  it('refuses the whole call before any work when a part needs a projector the model does not have', async () => {
    fake.projector = false;
    await expect(run(function* () {
      yield* (yield* embedder(undefined)).embed(['fine', { parts: [image] }]);
    })).rejects.toThrow(/input 1 .*image.*model\.embedding\.projector/);
    expect(log).toEqual([]);
  });

  it('refuses the whole call before any work when a part has nothing the projector reads, rather than leave it out', async () => {
    const notes = store.putAttachment({ representations: [store.putBlob(new TextEncoder().encode('# notes'), 'text/markdown')] });
    await expect(run(function* () {
      yield* (yield* embedder()).embed(['fine', { parts: ['see ', notes] }]);
    })).rejects.toThrow(/input 1 .*part 1.*nothing the projector reads/);
    expect(log).toEqual([]);
  });

  it('refuses the whole call before any work when an input is over the context, naming the setting', async () => {
    await expect(run(function* () {
      const e = yield* createEmbedder('/e.gguf', { nCtx: 8, pooling: 'mean', store, projector: '/mmproj.gguf' });
      yield* e.embed(['short', 'this text is too long']);
    })).rejects.toThrow(/input 1 is 21 cells.*model\.embedding\.context/);
    expect(log).toEqual([]);
  });
});
