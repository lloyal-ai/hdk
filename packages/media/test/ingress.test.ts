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

    // Not yet aborted when ingest starts (the queue admits it); aborted on the
    // next macrotask, which lands while sharp is inside the decode.
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 0);

    await expect(ingress.ingest(await png(), ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(putBlob).not.toHaveBeenCalled();
    expect(putAttachment).not.toHaveBeenCalled();
  });

  it('commits normally when nobody gave up', async () => {
    const store = new FileAttachmentStore(mkdtempSync(join(tmpdir(), 'ingress-')));
    const root = await createImageIngress(store).ingest(await png(), new AbortController().signal);
    expect(store.getManifest(root.digest)).toBeTruthy();
  });
});
