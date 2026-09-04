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
 * The store is content-addressed: a digest names bytes, and a read answers
 * those bytes or nothing. Serving by filename alone would trust the disk —
 * bit rot, a torn write, or a rewritten manifest would hand replay different
 * pixels under the original digest, and it would rebuild the wrong cells with
 * no complaint. EVERY read verifies; there is no unverified door, so the
 * manifest a trace root names is held to the same rule as the bytes it lists.
 */
const png = (background: string) =>
  sharp({ create: { width: 32, height: 32, channels: 3, background } }).png().toBuffer()
    .then((b) => new Uint8Array(b));

const blobPath = (dir: string, digest: string) =>
  join(dir, 'blobs', 'sha256', digest.slice('sha256:'.length));

describe('content-addressed reads', () => {
  it('get() refuses bytes that no longer hash to the name — drifted and absent are the same answer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-'));
    const store = new FileAttachmentStore(dir);
    const rep = store.putBlob(new Uint8Array([1, 2, 3, 4]), 'application/octet-stream');
    writeFileSync(blobPath(dir, rep.digest), new Uint8Array([9, 9, 9, 9]));

    expect(store.get(rep.digest)).toBeNull();
  });

  it('replay refuses a representation whose bytes drifted from their digest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-'));
    const store = new FileAttachmentStore(dir);
    const root = await createImageIngress(store).ingest(await png('#a70'), new AbortController().signal);
    const rep = representationsOf(store.getManifest(root.digest)!)[0];
    writeFileSync(blobPath(dir, rep.digest), new Uint8Array([0xff, 0xd8, 0xff, 0x00]));

    expect(() => materialize(store, [root])).toThrow(/digest/i);
  });

  it('replay refuses a manifest rewritten to point at other, valid blobs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-'));
    const store = new FileAttachmentStore(dir);
    const ingress = createImageIngress(store);
    const signal = new AbortController().signal;
    const a = await ingress.ingest(await png('#a70'), signal);
    const b = await ingress.ingest(await png('#07a'), signal);
    const manifestA = store.getManifest(a.digest)!;
    const repB = representationsOf(store.getManifest(b.digest)!)[0];
    const repsA = new Set(representationsOf(manifestA).map((d) => d.digest));
    // Every blob the forged manifest names is genuine and hashes to its own
    // digest — only the manifest lies about which of them belong to root A.
    const forged = {
      ...manifestA,
      layers: manifestA.layers.map((l) => (repsA.has(l.digest) ? repB : l)),
    };
    writeFileSync(blobPath(dir, a.digest), JSON.stringify(forged));
    expect(store.get(repB.digest)).not.toBeNull();

    expect(() => materialize(store, [a])).toThrow(/manifest/i);
  });
});
