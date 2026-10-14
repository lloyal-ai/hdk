/**
 * The blob upload surface and ranged playback: an original too large to hold
 * reaches the store chunk by chunk over the OCI distribution API, resumes
 * after an interruption, and is admitted only under the digest of the whole.
 * Once a video references it, a player seeks it through the attachment's
 * source route with Range.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FileAttachmentStore, createContentIngress } from '@lloyal-labs/media/node';
import { composeVideo } from '@lloyal-labs/media';
import { BlobUploads } from '../src/distribution';
import { createContentRoutes, parseByteRange } from '../src/content-routes';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(__dirname, '../../media/test/fixtures/video', name)));
const MP4 = fixture('red-square-moves.mp4');
const digestOf = (bytes: Uint8Array): string => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

const dirs: string[] = [];
function store(): { content: FileAttachmentStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'distribution-'));
  dirs.push(dir);
  return { content: new FileAttachmentStore(dir), dir };
}
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

const req = (method: string, path: string, extra: { query?: Record<string, string>; contentRange?: string; body?: Uint8Array } = {}) => ({
  method, path, query: new URLSearchParams(extra.query ?? {}),
  ...(extra.contentRange ? { contentRange: extra.contentRange } : {}),
  ...(extra.body ? { body: extra.body } : {}),
});

describe('the blob upload table', () => {
  it('answers the API version check', () => {
    const { content } = store();
    expect(new BlobUploads(content, content).resolve(req('GET', '/v2/'))!.status).toBe(200);
  });

  it('chunks in order, reports how far it got, and admits under the whole digest', () => {
    const { content } = store();
    const uploads = new BlobUploads(content, content);
    const open = uploads.resolve(req('POST', '/v2/lloyal/sources/blobs/uploads/'))!;
    expect(open.status).toBe(202);
    const location = open.headers.Location;
    expect(location).toMatch(/^\/v2\/lloyal\/sources\/blobs\/uploads\/[0-9a-f]{32}$/);

    const half = Math.floor(MP4.length / 2);
    const first = uploads.resolve(req('PATCH', location, { contentRange: `0-${half - 1}`, body: MP4.subarray(0, half) }))!;
    expect(first.status).toBe(202);
    expect(first.headers.Range).toBe(`0-${half - 1}`);

    // A client that lost track asks where to resume.
    expect(uploads.resolve(req('GET', location))!.headers.Range).toBe(`0-${half - 1}`);

    // A chunk that does not start where the last ended is refused, not reordered.
    const skip = uploads.resolve(req('PATCH', location, { contentRange: `${half + 10}-${MP4.length - 1}`, body: MP4.subarray(half + 10) }))!;
    expect(skip.status).toBe(416);
    expect(skip.headers.Range).toBe(`0-${half - 1}`);

    const close = uploads.resolve(req('PUT', location, { query: { digest: digestOf(MP4) }, contentRange: `${half}-${MP4.length - 1}`, body: MP4.subarray(half) }))!;
    expect(close.status).toBe(201);
    expect(close.headers['Docker-Content-Digest']).toBe(digestOf(MP4));
    expect(content.get(digestOf(MP4))).toEqual(MP4);
    expect(uploads.resolve(req('HEAD', `/v2/lloyal/sources/blobs/${digestOf(MP4)}`))!.headers['Content-Length']).toBe(String(MP4.length));
  });

  it('uploads in one request when the digest rides the POST', () => {
    const { content } = store();
    const reply = new BlobUploads(content, content).resolve(req('POST', '/v2/r/blobs/uploads/', { query: { digest: digestOf(MP4) }, body: MP4 }))!;
    expect(reply.status).toBe(201);
    expect(content.size(digestOf(MP4))).toBe(MP4.length);
  });

  it('a digest mismatch admits nothing; a cancelled upload leaves nothing; an unknown session is named', () => {
    const { content, dir } = store();
    const uploads = new BlobUploads(content, content);
    const a = uploads.resolve(req('POST', '/v2/r/blobs/uploads/'))!.headers.Location;
    uploads.resolve(req('PATCH', a, { body: MP4 }));
    const wrong = uploads.resolve(req('PUT', a, { query: { digest: digestOf(new Uint8Array([1])) } }))!;
    expect(wrong.status).toBe(400);
    expect(JSON.parse(new TextDecoder().decode(wrong.body)).errors[0].code).toBe('DIGEST_INVALID');
    expect(readdirSync(join(dir, 'blobs', 'sha256'))).toEqual([]);

    const b = uploads.resolve(req('POST', '/v2/r/blobs/uploads/'))!.headers.Location;
    uploads.resolve(req('PATCH', b, { body: MP4 }));
    expect(uploads.resolve(req('DELETE', b))!.status).toBe(204);
    expect(readdirSync(join(dir, '.tmp')).filter(f => f.startsWith('upload.'))).toEqual([]);
    expect(uploads.resolve(req('GET', b))!.status).toBe(404);
  });

  it('reads a blob back by digest, whole and verified, or by range', async () => {
    const { content, dir } = store();
    const d = content.putBlob(MP4, 'video/mp4');
    const uploads = new BlobUploads(content, content);
    const whole = uploads.resolve(req('GET', `/v2/r/blobs/${d.digest}`))!;
    expect(whole.status).toBe(200);
    expect(whole.body).toEqual(MP4);
    const part = uploads.resolve({ ...req('GET', `/v2/r/blobs/${d.digest}`), range: 'bytes=10-19' })!;
    expect(part.status).toBe(206);
    expect(part.headers['Content-Range']).toBe(`bytes 10-19/${MP4.length}`);
    expect(uploads.resolve(req('GET', `/v2/r/blobs/sha256:${'0'.repeat(64)}`))!.status).toBe(404);
    expect(uploads.resolve(req('DELETE', `/v2/r/blobs/${d.digest}`))!.status).toBe(405);
    // A drifted blob is refused whole, never served as though it matched.
    const drifted = MP4.slice(); drifted[3] ^= 0xff;
    writeFileSync(join(dir, 'blobs', 'sha256', d.digest.slice(7)), drifted);
    expect(uploads.resolve(req('GET', `/v2/r/blobs/${d.digest}`))!.status).toBe(404);
  });
});

describe('Range on a retained original', () => {
  it('parses the forms a player sends', () => {
    expect(parseByteRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=100-', 100)).toBeNull();
  });

  it('over HTTP: chunked push, compose, then 206 slices of the source and a 416 past its end', async () => {
    const { content } = store();
    const ingress = createContentIngress(content);
    const routes = createContentRoutes({ store: content, uploads: new BlobUploads(content, content), allowedOrigin: 'http://localhost:5173' });
    const server = createServer((rq, rs) => { if (!routes(rq, rs)) { rs.writeHead(404); rs.end(); } });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const open = await fetch(`${base}/v2/lloyal/sources/blobs/uploads/`, { method: 'POST' });
      expect(open.headers.get('access-control-expose-headers')).toContain('Location');
      const location = open.headers.get('location')!;
      const cut = 1_000;
      await fetch(base + location, { method: 'PATCH', headers: { 'Content-Range': `0-${cut - 1}` }, body: MP4.subarray(0, cut) as BodyInit });
      const done = await fetch(`${base}${location}?digest=${digestOf(MP4)}`, {
        method: 'PUT', headers: { 'Content-Range': `${cut}-${MP4.length - 1}` }, body: MP4.subarray(cut) as BodyInit,
      });
      expect(done.status).toBe(201);

      const frames = await Promise.all(['frame-00.png', 'frame-01.png'].map(async (n, i) => ({ root: await ingress.ingest(fixture(n)), tMs: i * 250 })));
      const root = await composeVideo(content, {
        frames, sampling: { fps: 4, timestampIntervalMs: 5000, maxFrames: 64 }, durationMs: 4000,
        source: { mediaType: 'application/octet-stream', digest: digestOf(MP4), size: MP4.length },
      });
      const source = `${base}/v1/media/${root.digest}/source`;

      const whole = await fetch(source);
      expect(whole.headers.get('accept-ranges')).toBe('bytes');
      expect(whole.headers.get('content-type')).toBe('video/mp4');

      const slice = await fetch(source, { headers: { Range: 'bytes=100-199' } });
      expect(slice.status).toBe(206);
      expect(slice.headers.get('content-range')).toBe(`bytes 100-199/${MP4.length}`);
      expect(new Uint8Array(await slice.arrayBuffer())).toEqual(MP4.subarray(100, 200));

      const tail = await fetch(source, { headers: { Range: `bytes=${MP4.length - 5}-` } });
      expect(new Uint8Array(await tail.arrayBuffer())).toEqual(MP4.subarray(MP4.length - 5));

      const past = await fetch(source, { headers: { Range: `bytes=${MP4.length}-` } });
      expect(past.status).toBe(416);
      expect(past.headers.get('content-range')).toBe(`bytes */${MP4.length}`);
    } finally {
      await new Promise<void>(r => server.close(() => r()));
    }
  });
});

describe('pushBlob, the page side of the upload', () => {
  it('pushes in chunks, resumes after a dropped chunk, and lands the exact digest', async () => {
    const { content } = store();
    const routes = createContentRoutes({ store: content, uploads: new BlobUploads(content, content) });
    const server = createServer((rq, rs) => { if (!routes(rq, rs)) { rs.writeHead(404); rs.end(); } });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { pushBlob } = await import('@lloyal-labs/media');
    const real = globalThis.fetch;
    let dropped = false;
    // The second chunk reaches the host, but its answer is lost on the way back.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await real(input, init);
      if (init?.method === 'PATCH' && (init.headers as Record<string, string>)['Content-Range']?.startsWith('700-') && !dropped) {
        dropped = true;
        throw new TypeError('network error');
      }
      return res;
    }) as typeof fetch;
    try {
      const sent: number[] = [];
      const d = await pushBlob(base, new Blob([MP4 as BlobPart], { type: 'video/mp4' }), { chunkBytes: 700, onProgress: (n) => sent.push(n) });
      expect(dropped).toBe(true);
      expect(d).toEqual({ mediaType: 'video/mp4', digest: digestOf(MP4), size: MP4.length });
      expect(sent.at(-1)).toBe(MP4.length);
      expect(content.get(digestOf(MP4))).toEqual(MP4);
    } finally {
      globalThis.fetch = real;
      await new Promise<void>(r => server.close(() => r()));
    }
  });

  it('a push that is cancelled part way gives back what the host staged for it', async () => {
    const { content, dir } = store();
    const routes = createContentRoutes({ store: content, uploads: new BlobUploads(content, content) });
    const server = createServer((rq, rs) => { if (!routes(rq, rs)) { rs.writeHead(404); rs.end(); } });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { pushBlob } = await import('@lloyal-labs/media');
    const cancel = new AbortController();
    try {
      const pushed = pushBlob(base, new Blob([MP4 as BlobPart], { type: 'video/mp4' }), {
        chunkBytes: 700, signal: cancel.signal, onProgress: () => cancel.abort(),
      });
      await expect(pushed).rejects.toThrow();
      expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
      expect(content.get(digestOf(MP4))).toBeNull();
    } finally {
      await new Promise<void>(r => server.close(() => r()));
    }
  });
});
