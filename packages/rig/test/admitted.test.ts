/**
 * `admitted(descriptors)` — the wire's attachment claims checked once, for
 * every product. A descriptor arrives from a client as JSON: a CLAIM about
 * content, not a fact. Three questions, in order: is it even the kind of thing
 * that can be a root (`asAttachment`); is the content really in the store
 * (`materialize`, the check no client can answer for itself); and, when any of
 * it is pixels, can this model see (`supportsVision`). A refusal moves nothing.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from 'effection';
import { Attachments, Ctx } from '@lloyal-labs/lloyal-agents';
import { FileAttachmentStore } from '@lloyal-labs/media/node';
import { MockSessionContext } from '@lloyal-labs/sdk/dist/testing.js';
import type { SessionContext } from '@lloyal-labs/sdk';
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
  const mock = new MockSessionContext();
  mock.mockSupportsVision = vision;
  yield* Attachments.set(store);
  yield* Ctx.set(mock as unknown as SessionContext);
}

describe('admitted', () => {
  it('nothing claimed: nothing admitted, nothing refused', async () => {
    const { store } = plant();
    const out = await run(function* () {
      yield* withContexts(store, true);
      return yield* admitted([]);
    });
    expect(out).toEqual({ roots: [], bitmaps: [], projected: [] });
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

  it('pixels need sight: an image is refused on a model with no projector, a document is not', async () => {
    const { store, image, document } = plant();
    const [seen, blind] = await run(function* () {
      yield* withContexts(store, false);
      return [yield* admitted([document]), yield* admitted([image])];
    });
    if ('refused' in seen) throw new Error(seen.refused);
    expect(seen.roots).toHaveLength(1);
    expect(seen.bitmaps).toEqual([]);
    expect((blind as { refused: string }).refused).toMatch(/see images|vision/);
  });
});
