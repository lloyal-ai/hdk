/**
 * Task framing: the caller names what an input is for (a task, a query or a
 * document, a title) and the embedder writes the model's own text for it,
 * from the framing its catalog entry carries. Proven against a fake native
 * context that records the text it is asked to read.
 */
import { Attachments } from '@lloyal-labs/lloyal-agents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from 'effection';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Attachment } from '@lloyal-labs/media';
import { createContentIngress, FileAttachmentStore } from '@lloyal-labs/media/node';
import type { EmbeddingFraming } from '../src/retrieval';

const { createContext, fake, read } = vi.hoisted(() => {
  const read: string[] = [];
  const fake = {
    width: 768,
    // A token per character, its code, so what is encoded reads back as the text it was.
    tokenize: async (text: string) => Array.from(text, (c) => c.charCodeAt(0)),
    kvCacheClear: async () => {},
    encode: async (tokens: number[]) => { read.push(String.fromCharCode(...tokens)); },
    encodeMultimodal: async (prompt: string) => { read.push(prompt); },
    _cellsMultimodal: async (_sep: number[], prompt: string) => prompt.length + 100,
    getEmbeddings: () => new Float32Array(fake.width),
    getEmbeddingDimension: () => fake.width,
    supportsVision: () => true,
    supportsAudio: () => true,
    audioSampleRate: () => 16_000,
    dispose: async () => {},
  };
  return { read, fake, createContext: vi.fn(async (_opts: Record<string, unknown>) => fake) };
});
vi.mock('@lloyal-labs/sdk/node', () => ({ createContext }));
const { createEmbedder } = await import('../src/providers/embedding');

const MARKER = '<__media__>';
const FRAMING: EmbeddingFraming = {
  search: { query: 'task: search result | query: ', document: 'title: none | text: ', titled: 'title: {title} | text: ' },
  clustering: { query: 'task: clustering | query: ', document: 'task: clustering | query: ' },
};

let dir: string;
let store: FileAttachmentStore;
let image: Attachment;
beforeEach(async () => {
  read.length = 0;
  fake.width = 768;
  dir = mkdtempSync(join(tmpdir(), 'embedder-framing-'));
  store = new FileAttachmentStore(dir);
  image = await createContentIngress(store).ingest(new Uint8Array(readFileSync(join(__dirname, '../../media/test/fixtures/video/frame-00.png'))));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** An embedder reading attachments from the run's store, as a harness's does. */
function* framed(opts: { framing?: EmbeddingFraming; dimensions?: number[] } = { framing: FRAMING }) {
  yield* Attachments.set(store);
  return yield* createEmbedder('/e.gguf', { nCtx: 2048, pooling: 'mean', projector: '/mmproj.gguf', ...opts });
}

describe('createEmbedder: task framing from the catalog', () => {
  it('frames a bare string as a document for search, the default task', async () => {
    await run(function* () {
      yield* (yield* framed()).embed(['a cat asleep on a sofa']);
    });
    expect(read).toEqual(['title: none | text: a cat asleep on a sofa']);
  });

  it('frames a query, and a document with its title, as the model asks', async () => {
    await run(function* () {
      yield* (yield* framed()).embed([
        { parts: ['a sleeping cat'], role: 'query' },
        { parts: ['a cat asleep on a sofa'], role: 'document', title: 'Cats' },
      ]);
    });
    expect(read).toEqual(['task: search result | query: a sleeping cat', 'title: Cats | text: a cat asleep on a sofa']);
  });

  it('writes a title exactly as given, whatever characters it holds', async () => {
    await run(function* () {
      yield* (yield* framed()).embed([{ parts: ['price list'], title: 'Costs in $& and $$ and $`' }]);
    });
    expect(read).toEqual(['title: Costs in $& and $$ and $` | text: price list']);
  });

  it('keeps a literal media marker in the text of a multimodal input from standing for media; text alone is read as written', async () => {
    await run(function* () {
      const e = yield* framed();
      yield* e.embed([{ parts: [`a ${MARKER} tag beside `, image], title: `Using ${MARKER}` }]);
      yield* e.embed([{ parts: [`a ${MARKER} tag`] }]);
    });
    const [multimodal, textAlone] = read;
    expect(multimodal.split(MARKER)).toHaveLength(2);
    expect(multimodal).toBe(`title: Using <media> | text: a <media> tag beside ${MARKER}`);
    expect(textAlone).toBe(`title: none | text: a ${MARKER} tag`);
  });

  it('frames a symmetric task the same on both sides, and leaves a title out where the task has no place for one', async () => {
    await run(function* () {
      yield* (yield* framed()).embed([
        { parts: ['a cat'], task: 'clustering', role: 'query' },
        { parts: ['a cat'], task: 'clustering', title: 'Cats' },
      ]);
    });
    expect(read).toEqual(['task: clustering | query: a cat', 'task: clustering | query: a cat']);
  });

  it('frames text around media, and leaves media alone unframed', async () => {
    await run(function* () {
      yield* (yield* framed()).embed([{ parts: ['a photo of ', image], role: 'query' }, { parts: [image] }]);
    });
    expect(read).toEqual([`task: search result | query: a photo of ${MARKER}`, MARKER]);
  });

  it('measures the framed input, which is what is encoded', async () => {
    const cells = await run(function* () {
      return yield* (yield* framed()).measure([{ parts: ['a cat'], role: 'query' }]);
    });
    expect(cells).toEqual(['task: search result | query: a cat'.length]);
  });

  it('says which tasks it frames, and refuses the whole call before any work for one it does not', async () => {
    await expect(run(function* () {
      const e = yield* framed();
      expect(e.tasks).toEqual(['search', 'clustering']);
      yield* e.embed(['fine', { parts: ['a claim'], task: 'fact-checking', role: 'query' }]);
    })).rejects.toThrow(/input 1 is for fact-checking.*frames search and clustering.*model\.embedding/);
    expect(read).toEqual([]);
  });

  it('embeds text as given for a model that declares no framing, and refuses a task it cannot frame', async () => {
    await run(function* () {
      const e = yield* framed({});
      expect(e.tasks).toEqual([]);
      yield* e.embed(['as given', { parts: ['a query'], role: 'query' }]);
    });
    expect(read).toEqual(['as given', 'a query']);
    await expect(run(function* () {
      yield* (yield* framed({})).embed([{ parts: ['a cat'], task: 'search' }]);
    })).rejects.toThrow(/input 0 is for search.*frames no task/);
  });

  it('answers the widths the model was trained to be cut to, its own width first', async () => {
    const widths = await run(function* () {
      return [(yield* framed({ dimensions: [128, 768, 256, 512] })).dimensions, (yield* framed({})).dimensions];
    });
    expect(widths).toEqual([[768, 512, 256, 128], [768]]);
  });

  it('refuses to load when the model file answers a width its catalog entry was not trained to', async () => {
    fake.width = 1024;
    await expect(run(function* () {
      yield* framed({ dimensions: [768, 512] });
    })).rejects.toThrow(/answers 1024.*768/);
  });
});
