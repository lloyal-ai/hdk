/**
 * createImageIngress — the official ingress. One promise the HTTP route makes
 * on its behalf: after the end-to-end deadline nothing is committed. sharp
 * cannot be interrupted mid-decode, so the ingress must look at the signal
 * again AFTER normalization and BEFORE the first store write.
 */
import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAttachmentStore } from '../src/node';
import { createImageIngress } from '../src/image';

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
