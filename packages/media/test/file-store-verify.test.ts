import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAttachmentStore } from '../src/node';
import { createImageIngress } from '../src/image';
import { materialize } from '../src/ingress';
import { representationsOf } from '../src/attachment';

/**
 * The store is content-addressed: a digest names bytes. Serving by filename
 * alone trusts the disk. Bit rot or a torn write would hand replay different
 * pixels under the original digest and it would rebuild the wrong cells with
 * no complaint. Replay verifies; the hot HTTP path keeps trusting the name.
 */
const png = () =>
  sharp({ create: { width: 32, height: 32, channels: 3, background: '#a70' } }).png().toBuffer()
    .then((b) => new Uint8Array(b));

const blobPath = (dir: string, digest: string) =>
  join(dir, 'blobs', 'sha256', digest.slice('sha256:'.length));

describe('content-addressed reads', () => {
  it('get() serves by name; get(digest, { verify: true }) refuses bytes that no longer hash to it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-'));
    const store = new FileAttachmentStore(dir);
    const rep = store.putBlob(new Uint8Array([1, 2, 3, 4]), 'application/octet-stream');
    writeFileSync(blobPath(dir, rep.digest), new Uint8Array([9, 9, 9, 9]));

    expect(store.get(rep.digest)).toEqual(new Uint8Array([9, 9, 9, 9]));
    expect(store.get(rep.digest, { verify: true })).toBeNull();
  });

  it('replay refuses a representation whose bytes drifted from their digest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-'));
    const store = new FileAttachmentStore(dir);
    const root = await createImageIngress(store).ingest(await png(), new AbortController().signal);
    const rep = representationsOf(store.getManifest(root.digest)!)[0];
    writeFileSync(blobPath(dir, rep.digest), new Uint8Array([0xff, 0xd8, 0xff, 0x00]));

    expect(() => materialize(store, [root])).toThrow(/digest/i);
  });
});
