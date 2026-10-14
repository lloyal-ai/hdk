/**
 * `admitted(descriptors)` — the wire's attachment claims checked once, for
 * every product. A descriptor arrives from a client as JSON: a CLAIM about
 * content, not a fact. Three questions, in order: is it even the kind of thing
 * that can be a root (`asAttachment`); is the content really in the store
 * (`materialize`, the check no client can answer for itself); and, when any of
 * it is pixels, is the `vision` service configured — the one refusal every
 * unconfigured service gives. A fourth, when the harness sets one: does the
 * turn's media fit the share of the context it may fill. A refusal moves
 * nothing.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from 'effection';
import { Attachments, Ctx } from '@lloyal-labs/lloyal-agents';
import { MockSessionContext } from '../../sdk/src/testing.js';
import { Services } from '../src/services';
import { FileAttachmentStore, createContentIngress } from '@lloyal-labs/media/node';
import { composeVideo } from '@lloyal-labs/media';
import { buildUserDeltaMultimodal, deltaCells } from '@lloyal-labs/sdk';
import { admitted } from '../src/admitted';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function plant() {
  const store = new FileAttachmentStore(fs.mkdtempSync(path.join(os.tmpdir(), 'admitted-')));
  const image = store.putAttachment({ representations: [store.putBlob(PNG, 'image/png')] });
  const document = store.putAttachment({
    representations: [store.putBlob(new TextEncoder().encode('page one'), 'text/plain')],
  });
  return { store, image, document };
}

function* withContexts(store: FileAttachmentStore, vision: boolean) {
  yield* Attachments.set(store);
  yield* Services.set(vision ? { vision: { artifact: '/models/vision/projector.gguf' } } : {});
}

describe('admitted', () => {
  it('nothing claimed: nothing admitted, nothing refused', async () => {
    const { store } = plant();
    const out = await run(function* () {
      yield* withContexts(store, true);
      return yield* admitted([]);
    });
    expect(out).toEqual({ roots: [], bitmaps: [], projected: [], videos: [] });
  });

  it('a descriptor that is not the kind of thing that can be a root is refused', async () => {
    const { store } = plant();
    const out = await run(function* () {
      yield* withContexts(store, true);
      return yield* admitted([{ digest: 'not-a-digest', mediaType: 'image/png', size: 1 }]);
    });
    expect(out).toHaveProperty('refused');
    expect((out as { refused: string }).refused).toMatch(/admitted/);
  });

  it('a well-formed root the store does not hold is refused, saying it could not be read back', async () => {
    const { store, image } = plant();
    const forged = { ...image, digest: 'sha256:' + '0'.repeat(64) };
    const out = await run(function* () {
      yield* withContexts(store, true);
      return yield* admitted([forged]);
    });
    expect((out as { refused: string }).refused).toMatch(/read .* back/);
  });

  it('an image is a root, a bitmap and a projection; a document is a root only', async () => {
    const { store, image, document } = plant();
    const out = await run(function* () {
      yield* withContexts(store, true);
      return yield* admitted([image, document]);
    });
    if ('refused' in out) throw new Error(out.refused);
    expect(out.roots.map((r) => r.digest)).toEqual([image.digest, document.digest]);
    expect(out.bitmaps).toHaveLength(1);
    expect(out.bitmaps[0]).toEqual(PNG);
    expect(out.projected.map((r) => r.digest)).toEqual([image.digest]);
  });

  it('a video is one input and named among the videos, so a harness can say how to cite it', async () => {
    const { store, image } = plant();
    const ingress = createContentIngress(store);
    const frames = await Promise.all(['frame-00.png', 'frame-01.png'].map(async (name, i) => ({
      root: await ingress.ingest(new Uint8Array(fs.readFileSync(path.join(__dirname, '../../media/test/fixtures/video', name)))),
      tMs: i * 250,
    })));
    const video = await composeVideo(store, { frames, sampling: { fps: 4, timestampIntervalMs: 5000, maxFrames: 64 }, durationMs: 500 });
    const out = await run(function* () {
      yield* withContexts(store, true);
      return yield* admitted([image, video]);
    });
    if ('refused' in out) throw new Error(out.refused);
    expect(out.bitmaps).toHaveLength(2);
    expect(out.bitmaps[1]).toMatchObject({ kind: 'video', timestampsMs: [0, 250] });
    expect(out.videos.map((r) => r.digest)).toEqual([video.digest]);
  });

  it('pixels need sight: an image is refused where vision is not configured, naming the block; a document is not', async () => {
    const { store, image, document } = plant();
    const [seen, blind] = await run(function* () {
      yield* withContexts(store, false);
      return [yield* admitted([document]), yield* admitted([image])];
    });
    if ('refused' in seen) throw new Error(seen.refused);
    expect(seen.roots).toHaveLength(1);
    expect(seen.bitmaps).toEqual([]);
    expect((blind as { refused: string }).refused).toBe('`vision` is not configured — add `model.vision` to harness.yml');
  });

  describe('the share of the context attachments may fill', () => {
    // The mock prices an image at `mockImageCells` and its prompt at a cell per character,
    // so the fixed cost of one image's turn is measured, not assumed.
    function* priced(store: FileAttachmentStore, ctx: MockSessionContext) {
      yield* withContexts(store, true);
      yield* Ctx.set(ctx);
    }

    it('a turn whose media fits within the share is admitted', async () => {
      const { store, image } = plant();
      const ctx = new MockSessionContext({ nCtx: 10_000 });
      const out = await run(function* () {
        yield* priced(store, ctx);
        return yield* admitted([image], { context: 0.5 });
      });
      if ('refused' in out) throw new Error(out.refused);
      expect(out.bitmaps).toHaveLength(1);
    });

    it('a turn whose media would fill more than the share is refused, saying what it costs and what is allowed', async () => {
      const { store, image } = plant();
      const ctx = new MockSessionContext({ nCtx: 10_000 });
      ctx.mockImageCells = 6_000;
      const out = await run(function* () {
        yield* priced(store, ctx);
        return yield* admitted([image], { context: 0.5 });
      });
      expect((out as { refused: string }).refused).toMatch(/would take 6,\d{3} of the 10,000-token context; this harness lets attachments fill up to 50% of it/);
    });

    it('a turn within the share but larger than what the context has free is refused: it would overflow', async () => {
      const { store, image } = plant();
      const ctx = new MockSessionContext({ nCtx: 10_000, cellsUsed: 8_000 });
      ctx.mockImageCells = 3_000;
      const out = await run(function* () {
        yield* priced(store, ctx);
        return yield* admitted([image], { context: 0.5 });
      });
      expect((out as { refused: string }).refused).toMatch(/would take 3,\d{3} tokens, but only 2,000 of the 10,000-token context are free/);
    });

    it('media the kernel cannot lay out is refused when priced, never thrown into the run', async () => {
      const { store, image } = plant();
      const ctx = new MockSessionContext({ nCtx: 10_000 });
      ctx._cellsMultimodal = async () => { throw new Error('MtmdSource - video timestamps must increase'); };
      const out = await run(function* () {
        yield* priced(store, ctx);
        return yield* admitted([image], { context: 0.5 });
      });
      expect((out as { refused: string }).refused).toBe("That attachment can't be read in: MtmdSource - video timestamps must increase");
    });

    it('the limit is inclusive: exactly the share is admitted, one cell over is not', async () => {
      const { store, image } = plant();
      const ctx = new MockSessionContext({ nCtx: 10_000 });
      ctx.mockImageCells = 0;
      const fixed = await deltaCells(ctx, buildUserDeltaMultimodal(ctx, '', [PNG]));
      const at = (cells: number) => {
        ctx.mockImageCells = cells;
        return run(function* () { yield* priced(store, ctx); return yield* admitted([image], { context: 0.5 }); });
      };
      expect(await at(5_000 - fixed)).not.toHaveProperty('refused');
      expect(await at(5_001 - fixed)).toHaveProperty('refused');
    });

    it('without a share, nothing is priced: no context is needed', async () => {
      const { store, image } = plant();
      const out = await run(function* () {
        yield* withContexts(store, true);
        return yield* admitted([image]);
      });
      expect(out).not.toHaveProperty('refused');
    });

    it('a document alone is never priced: it is not prefilled', async () => {
      const { store, document } = plant();
      const ctx = new MockSessionContext({ nCtx: 10 });
      const out = await run(function* () {
        yield* priced(store, ctx);
        return yield* admitted([document], { context: 0.5 });
      });
      expect(out).not.toHaveProperty('refused');
    });

    it('a share outside (0, 1] is the developer\'s mistake, thrown rather than said to the reader', async () => {
      const { store, image } = plant();
      const ctx = new MockSessionContext({ nCtx: 10_000 });
      for (const context of [0, -0.5, 1.5, Number.NaN]) {
        await expect(run(function* () {
          yield* priced(store, ctx);
          return yield* admitted([image], { context });
        })).rejects.toThrow(/context.*between 0 and 1/);
      }
    });
  });
});
