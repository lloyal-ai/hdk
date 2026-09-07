/**
 * One door, the bytes deciding: an image to the normalizer, a PDF to the
 * document ingress, junk refused.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { FileAttachmentStore } from '../src/node';
import { createContentIngress, DOCUMENT_UPLOAD_TIMEOUT_MS } from '../src/content-ingress';
import { DOCUMENT_CONFIG_TYPE } from '../src/document';
import { EMPTY_DESCRIPTOR } from '../src/attachment';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'pdf', name)));

describe('createContentIngress', () => {
  it('admits an image as an image manifest', async () => {
    const store = new FileAttachmentStore(mkdtempSync(join(tmpdir(), 'content-ingress-')));
    const png = new Uint8Array(await sharp({ create: { width: 32, height: 32, channels: 3, background: '#0a7' } }).png().toBuffer());
    const root = await createContentIngress(store).ingest(png);
    const manifest = store.getManifest(root.digest)!;
    expect(manifest.config.digest).toBe(EMPTY_DESCRIPTOR.digest);
    expect(manifest.layers[0].mediaType).toBe('image/png');
  });

  it('admits a PDF as a document manifest', async () => {
    const store = new FileAttachmentStore(mkdtempSync(join(tmpdir(), 'content-ingress-')));
    const root = await createContentIngress(store).ingest(fixture('untagged.pdf'));
    expect(store.getManifest(root.digest)!.config.mediaType).toBe(DOCUMENT_CONFIG_TYPE);
  }, 60_000);

  it('refuses bytes that are neither', async () => {
    const store = new FileAttachmentStore(mkdtempSync(join(tmpdir(), 'content-ingress-')));
    await expect(createContentIngress(store).ingest(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).rejects.toThrow();
  });

  it('states the upload allowance a host passes beside the byte ceiling', () => {
    expect(DOCUMENT_UPLOAD_TIMEOUT_MS).toBe(180_000);
  });
});
