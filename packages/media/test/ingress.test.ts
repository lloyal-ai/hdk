/**
 * createImageIngress — the official ingress. One promise the HTTP route makes
 * on its behalf: after the end-to-end deadline nothing is committed. sharp
 * cannot be interrupted mid-decode, so the ingress must look at the signal
 * again AFTER normalization and BEFORE the first store write.
 */
import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAttachmentStore } from '../src/node';
import { createImageIngress } from '../src/image';
import { materialize } from '../src/ingress';
import { ContentLost } from '../src/store';

const png = () =>
  sharp({ create: { width: 64, height: 64, channels: 3, background: '#0a7' } }).png().toBuffer()
    .then((b) => new Uint8Array(b));

describe('createImageIngress', () => {
  it('commits nothing when the signal aborted during the decode', async () => {
    const store = new FileAttachmentStore(mkdtempSync(join(tmpdir(), 'ingress-')));
    const putBlob = vi.spyOn(store, 'putBlob');
    const putAttachment = vi.spyOn(store, 'putAttachment');
    const ingress = createImageIngress(store);

    // Fixture FIRST: nothing may abort while it is being built, or the
    // signal is already dead when ingest() is entered and the throw comes
    // from the gate's preflight — a different guard than the one under test.
    const bytes = await png();
    const ctrl = new AbortController();
    // ingest() runs synchronously through normalizeImage up to the gate's
    // `await acquire()`; with permits free, acquire's preflight and its
    // post-grant check have both already run by the time this returns.
    const pending = ingress.ingest(bytes, ctrl.signal);
    // So the only abort check left is the one AFTER normalization, before the
    // first store write. Aborting here proves THAT guard, not the preflight.
    ctrl.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(putBlob).not.toHaveBeenCalled();
    expect(putAttachment).not.toHaveBeenCalled();
  });

  it('commits normally when nobody gave up', async () => {
    const store = new FileAttachmentStore(mkdtempSync(join(tmpdir(), 'ingress-')));
    const root = await createImageIngress(store).ingest(await png(), new AbortController().signal);
    expect(store.getManifest(root.digest)).toBeTruthy();
  });
});

describe('materialize — inputs are the projector-decodable representations', () => {
  // A document's one representation is text. It reaches the model through
  // retrieval and the spine outline, never through the projector, so a
  // document root contributes NO inputs: feeding its bytes to the image
  // decoder would poison the branch it was prefilled on.
  it('yields no inputs for a root whose only representation is text/markdown', async () => {
    const store = new FileAttachmentStore(mkdtempSync(join(tmpdir(), 'materialize-')));
    const md = store.putBlob(new TextEncoder().encode('# Title\n\nBody.\n'), 'text/markdown');
    const root = store.putAttachment({ representations: [md] });

    const prepared = materialize(store, [root]);

    expect(prepared.attachments).toEqual([root]);
    expect(prepared.inputs).toEqual([]);
  });

  it('yields exactly the image inputs for a mixed batch, in root order', async () => {
    const store = new FileAttachmentStore(mkdtempSync(join(tmpdir(), 'materialize-')));
    const bytes = await png();
    const image = await createImageIngress(store).ingest(bytes);
    const md = store.putBlob(new TextEncoder().encode('text'), 'text/markdown');
    const doc = store.putAttachment({ representations: [md] });

    const prepared = materialize(store, [doc, image]);

    expect(prepared.attachments).toEqual([doc, image]);
    expect(prepared.inputs).toHaveLength(1);
    expect(prepared.inputs[0]).toEqual(bytes);
  });
});

describe('materialize — content that is gone or has drifted is ContentLost, and only that', () => {
  // The heal path stands down on ContentLost alone; any other throw from the store is a programming error that
  // must reach the run as it is, so the type is the whole contract.
  it('a root whose manifest is not in the store', () => {
    const store = new FileAttachmentStore(mkdtempSync(join(tmpdir(), 'materialize-')));
    const md = store.putBlob(new TextEncoder().encode('text'), 'text/markdown');
    const root = store.putAttachment({ representations: [md] });
    expect(() => materialize(store, [{ ...root, digest: 'sha256:' + 'f'.repeat(64) }])).toThrow(ContentLost);
  });

  it('an image whose blob is missing from the store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'materialize-'));
    const store = new FileAttachmentStore(dir);
    const image = store.putBlob(await png(), 'image/png');
    const root = store.putAttachment({ representations: [image] });
    rmSync(join(dir, 'blobs', 'sha256', image.digest.slice('sha256:'.length)));
    expect(() => materialize(store, [root])).toThrow(ContentLost);
  });

  it('a store that throws is not lost content: its error reaches the caller unchanged', () => {
    const store = new FileAttachmentStore(mkdtempSync(join(tmpdir(), 'materialize-')));
    const md = store.putBlob(new TextEncoder().encode('text'), 'text/markdown');
    const root = store.putAttachment({ representations: [md] });
    store.getManifest = () => { throw new TypeError('the store blew up'); };
    const thrown = (() => { try { materialize(store, [root]); return null; } catch (e) { return e; } })();
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).not.toBeInstanceOf(ContentLost);
  });
});
