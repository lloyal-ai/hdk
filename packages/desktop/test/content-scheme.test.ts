/**
 * The `attachment:` scheme seeks a retained original with Range and takes an
 * original's chunks over the blob upload surface, as the served host does.
 * Chromium registers the scheme with `stream: true`, sends `Range: bytes=N-`
 * when a player seeks, and assumes the body starts at that offset.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FileAttachmentStore, createContentIngress } from '@lloyal-labs/media/node';
import { composeVideo } from '@lloyal-labs/media';
import { BlobUploads } from '@lloyal-labs/rig/node';
import { contentHandler } from '../src/content';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(__dirname, '../../media/test/fixtures/video', name)));
const MP4 = fixture('red-square-moves.mp4');
const digest = 'sha256:' + createHash('sha256').update(MP4).digest('hex');

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

describe('the attachment scheme', () => {
  it('takes an original in chunks, then serves the composed video\'s source by range', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scheme-'));
    dirs.push(dir);
    const store = new FileAttachmentStore(dir);
    const ingress = createContentIngress(store);
    const handle = contentHandler({ store, uploads: new BlobUploads(store, store), ingest: (b, s) => ingress.ingest(b, s) });
    const at = (path: string, init?: RequestInit) => handle(new Request(`attachment://store${path}`, init));

    const open = await at('/v2/lloyal/sources/blobs/uploads/', { method: 'POST' });
    expect(open.status).toBe(202);
    const location = open.headers.get('location')!;
    const cut = 2_000;
    expect((await at(location, { method: 'PATCH', headers: { 'Content-Range': `0-${cut - 1}` }, body: MP4.subarray(0, cut) as BodyInit })).status).toBe(202);
    const done = await at(`${location}?digest=${digest}`, { method: 'PUT', body: MP4.subarray(cut) as BodyInit });
    expect(done.status).toBe(201);

    const frames = await Promise.all(['frame-00.png', 'frame-01.png'].map(async (n, i) => ({ root: await ingress.ingest(fixture(n)), tMs: i * 250 })));
    const root = await composeVideo(store, {
      frames, sampling: { fps: 4, timestampIntervalMs: 5000, maxFrames: 64 }, durationMs: 4000,
      source: { mediaType: 'application/octet-stream', digest, size: MP4.length },
    });

    const seek = await at(`/v1/media/${root.digest}/source`, { headers: { Range: 'bytes=1024-' } });
    expect(seek.status).toBe(206);
    expect(seek.headers.get('content-range')).toBe(`bytes 1024-${MP4.length - 1}/${MP4.length}`);
    expect(seek.headers.get('access-control-allow-origin')).toBe('*');
    expect(new Uint8Array(await seek.arrayBuffer())).toEqual(MP4.subarray(1024));
  });
});
