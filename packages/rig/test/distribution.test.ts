/**
 * The blob upload surface and ranged playback: an original too large to hold
 * reaches the store chunk by chunk over the OCI distribution API, resumes
 * after an interruption, and is admitted only under the digest of the whole.
 * Once a video references it, a player seeks it through the attachment's
 * source route with Range.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FileAttachmentStore, createContentIngress } from '@lloyal-labs/media/node';
import { composeVideo } from '@lloyal-labs/media';
import { BlobUploads } from '../src/distribution';
import { createContentRoutes, parseByteRange, resolveContent } from '../src/content-routes';

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

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of stream as unknown as AsyncIterable<Uint8Array>) parts.push(part);
  return new Uint8Array(Buffer.concat(parts));
}

const req = (method: string, path: string, extra: { query?: Record<string, string>; contentRange?: string; body?: Uint8Array } = {}) => ({
  method, path, query: new URLSearchParams(extra.query ?? {}),
  ...(extra.contentRange ? { contentRange: extra.contentRange } : {}),
  ...(extra.body ? { body: extra.body } : {}),
});

describe('the retained original', () => {
  it('answers HEAD from its size, never reading the whole original', async () => {
    const { content } = store();
    const ingress = createContentIngress(content);
    const source = content.putBlob(MP4, 'application/octet-stream');
    const frames = await Promise.all(['frame-00.png', 'frame-01.png'].map(async (n, i) => ({ root: await ingress.ingest(fixture(n)), tMs: i * 250 })));
    const root = await composeVideo(content, { frames, sampling: { fps: 4, timestampIntervalMs: 5000, maxFrames: 64 }, durationMs: 4000, source });
    const read: string[] = [];
    const get = content.get.bind(content);
    content.get = (digest: string) => { read.push(digest); return get(digest); };

    const head = resolveContent({ method: 'HEAD', path: `/v1/media/${root.digest}/source` }, content)!;
    expect(head.status).toBe(200);
    expect(head.headers).toMatchObject({ 'Content-Length': String(MP4.length), 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
    expect(head.body).toBeUndefined();
    expect(read).not.toContain(source.digest);
  });

  it('serves GET whole as a verified stream, never holding the original in memory', async () => {
    const { content } = store();
    const ingress = createContentIngress(content);
    const source = content.putBlob(MP4, 'application/octet-stream');
    const frames = await Promise.all(['frame-00.png', 'frame-01.png'].map(async (n, i) => ({ root: await ingress.ingest(fixture(n)), tMs: i * 250 })));
    const root = await composeVideo(content, { frames, sampling: { fps: 4, timestampIntervalMs: 5000, maxFrames: 64 }, durationMs: 4000, source });
    const read: string[] = [];
    const get = content.get.bind(content);
    content.get = (digest: string) => { read.push(digest); return get(digest); };

    const whole = resolveContent({ method: 'GET', path: `/v1/media/${root.digest}/source` }, content)!;
    expect(whole.status).toBe(200);
    expect(whole.headers).toMatchObject({ 'Content-Length': String(MP4.length), 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
    expect(whole.body).toBeUndefined();
    expect(await collect(whole.stream!)).toEqual(MP4);
    expect(read).not.toContain(source.digest);
  });
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

  it('refuses a chunk whose range does not describe its body, and stages nothing from it', () => {
    const { content } = store();
    const uploads = new BlobUploads(content, content);
    const location = uploads.resolve(req('POST', '/v2/r/blobs/uploads/'))!.headers.Location;
    const claims = [
      { contentRange: '0-0', body: MP4.subarray(0, 100) },     // claims one byte, sends a hundred
      { contentRange: '0-99', body: MP4.subarray(0, 10) },     // claims a hundred, sends ten
      { contentRange: '5-0', body: MP4.subarray(0, 1) },       // reversed
    ];
    for (const claim of claims) {
      const reply = uploads.resolve(req('PATCH', location, claim))!;
      expect(reply.status, claim.contentRange).toBe(400);
      expect(uploads.resolve(req('GET', location))!.headers.Range).toBe('0-0');
    }
    expect(uploads.resolve(req('PATCH', location, { contentRange: '0-99', body: MP4.subarray(0, 100) }))!.status).toBe(202);
  });

  it('lets go of a one-request upload\'s staging when writing it fails, so a full disk leaks nothing', () => {
    const { content } = store();
    const discarded: string[] = [];
    const staging = {
      stage() {
        const real = content.stage();
        return {
          get id() { return real.id; }, get size() { return real.size; },
          append() { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); },
          adopt: real.adopt.bind(real),
          discard() { discarded.push(real.id); real.discard(); },
        };
      },
    };
    const uploads = new BlobUploads(staging, content);
    const reply = uploads.resolve(req('POST', '/v2/r/blobs/uploads/', { query: { digest: digestOf(MP4) }, body: MP4 }))!;
    expect(reply.status).toBe(507);
    expect(discarded).toHaveLength(1);
  });

  it('answers a malformed escape in a blob\'s digest as the client\'s mistake, not a server fault', () => {
    const { content } = store();
    const reply = new BlobUploads(content, content).resolve(req('GET', '/v2/r/blobs/sha256%ZZ'))!;
    expect(reply.status).toBe(400);
    expect(JSON.parse(new TextDecoder().decode(reply.body!)).errors[0].code).toBe('DIGEST_INVALID');
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

  it('admits only the original of a video by default: a pushed image, manifest or text is refused and nothing is kept', () => {
    const { content, dir } = store();
    const uploads = new BlobUploads(content, content);
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const manifest = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, artifactType: 'application/vnd.lloyal.attachment.v1', layers: [] }));
    const text = new TextEncoder().encode('# a document the host never read');
    for (const bytes of [PNG, manifest, text]) {
      const reply = uploads.resolve(req('POST', '/v2/r/blobs/uploads/', { query: { digest: digestOf(bytes) }, body: bytes }))!;
      expect(reply.status).toBe(403);
      expect(JSON.parse(new TextDecoder().decode(reply.body!)).errors[0].code).toBe('DENIED');
    }
    expect(readdirSync(join(dir, 'blobs', 'sha256'))).toEqual([]);
    expect(readdirSync(join(dir, '.tmp')).filter(f => f.startsWith('upload.'))).toEqual([]);
    expect(uploads.resolve(req('POST', '/v2/r/blobs/uploads/', { query: { digest: digestOf(MP4) }, body: MP4 }))!.status).toBe(201);
  });

  it('serves no blob\'s bytes by digest by default: the attachment that holds it is the one door; existence still answers', () => {
    const { content } = store();
    const d = content.putBlob(MP4, 'video/mp4');
    const uploads = new BlobUploads(content, content);
    const read = uploads.resolve(req('GET', `/v2/r/blobs/${d.digest}`))!;
    expect(read.status).toBe(403);
    expect(read.stream).toBeUndefined();
    expect(uploads.resolve({ ...req('GET', `/v2/r/blobs/${d.digest}`), range: 'bytes=0-9' })!.status).toBe(403);
    expect(uploads.resolve(req('HEAD', `/v2/r/blobs/${d.digest}`))!.status).toBe(200);
  });

  it('as a registry, admits any blob', () => {
    const { content } = store();
    const bytes = new TextEncoder().encode('any bytes at all');
    const reply = new BlobUploads(content, content, { registry: true }).resolve(req('POST', '/v2/r/blobs/uploads/', { query: { digest: digestOf(bytes) }, body: bytes }))!;
    expect(reply.status).toBe(201);
  });

  it('as a registry, reads a blob back by digest, whole and verified, or by range', async () => {
    const { content, dir } = store();
    const d = content.putBlob(MP4, 'video/mp4');
    const uploads = new BlobUploads(content, content, { registry: true });
    const whole = uploads.resolve(req('GET', `/v2/r/blobs/${d.digest}`))!;
    expect(whole.status).toBe(200);
    expect(whole.body).toBeUndefined();
    expect(whole.headers['Content-Length']).toBe(String(MP4.length));
    expect(await collect(whole.stream!)).toEqual(MP4);
    const part = uploads.resolve({ ...req('GET', `/v2/r/blobs/${d.digest}`), range: 'bytes=10-19' })!;
    expect(part.status).toBe(206);
    expect(part.headers['Content-Range']).toBe(`bytes 10-19/${MP4.length}`);
    expect(uploads.resolve(req('GET', `/v2/r/blobs/sha256:${'0'.repeat(64)}`))!.status).toBe(404);
    expect(uploads.resolve(req('DELETE', `/v2/r/blobs/${d.digest}`))!.status).toBe(405);
    // A drifted blob is never served whole as though it matched: its stream errors before the last bytes.
    const drifted = MP4.slice(); drifted[3] ^= 0xff;
    writeFileSync(join(dir, 'blobs', 'sha256', d.digest.slice(7)), drifted);
    await expect(collect(uploads.resolve(req('GET', `/v2/r/blobs/${d.digest}`))!.stream!)).rejects.toThrow(/no longer matches its digest/);
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
      expect(new Uint8Array(await whole.arrayBuffer())).toEqual(MP4);

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
  it('resolves a one-byte first chunk whose send failed by sending it again, whether or not it had landed', async () => {
    const { pushBlob } = await import('@lloyal-labs/media');
    const realFetch = globalThis.fetch;
    const one = new Uint8Array([7]);
    // A minimal host whose first PATCH fails in transit: the byte either never arrives, or arrives and the reply is lost.
    for (const landed of [false, true]) {
      let held = new Uint8Array(0);
      let patches = 0;
      let closedWith = '';
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'POST') return new Response(null, { status: 202, headers: { Location: '/v2/r/blobs/uploads/s' } });
        if (method === 'PATCH') {
          patches++;
          const start = Number(/^(\d+)-/.exec(new Headers(init!.headers).get('Content-Range')!)![1]);
          if (patches === 1) {
            if (landed) held = one;
            throw new TypeError('network error');
          }
          if (start !== held.length) return new Response(null, { status: 416, headers: { Range: '0-0' } });
          held = one;
          return new Response(null, { status: 202, headers: { Range: '0-0' } });
        }
        if (method === 'PUT') { closedWith = String(url); return new Response(null, { status: 201 }); }
        return new Response(null, { status: 204, headers: { Range: '0-0' } });
      }) as typeof fetch;
      try {
        await pushBlob('http://host', new Blob([one]));
      } finally {
        globalThis.fetch = realFetch;
      }
      expect(held).toEqual(one);
      expect(patches).toBe(2);
      expect(closedWith).toContain('digest=');
    }
  });

  it('refuses a chunk size that cannot advance, before opening a session', async () => {
    const { pushBlob } = await import('@lloyal-labs/media');
    const opened: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => { opened.push(String(url)); return new Response(null, { status: 500 }); }) as typeof fetch;
    try {
      for (const chunkBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(pushBlob('http://host', new Blob([MP4 as BlobPart]), { chunkBytes })).rejects.toThrow(/chunk size must be a positive whole number of bytes/);
      }
      expect(opened).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

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

  it('a cancelled push rejects at once: it asks the host to let go of the staging, but does not wait to hear back', async () => {
    const { pushBlob } = await import('@lloyal-labs/media');
    const realFetch = globalThis.fetch;
    const cancel = new AbortController();
    const deletes: string[] = [];
    // A host whose cleanup never answers.
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST') return new Response(null, { status: 202, headers: { Location: '/v2/r/blobs/uploads/s' } });
      if (method === 'DELETE') { deletes.push(String(url)); return new Promise<Response>(() => {}); }
      return new Response(null, { status: 202, headers: { Range: '0-699' } });
    }) as typeof fetch;
    try {
      const pushed = pushBlob('http://host', new Blob([MP4 as BlobPart]), { chunkBytes: 700, signal: cancel.signal, onProgress: () => cancel.abort() });
      const settled = await Promise.race([pushed.then(() => 'resolved', () => 'rejected'), new Promise((r) => setTimeout(() => r('still waiting'), 500))]);
      expect(settled).toBe('rejected');
      expect(deletes).toEqual(['http://host/v2/r/blobs/uploads/s']);
    } finally {
      globalThis.fetch = realFetch;
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
      await vi.waitFor(() => expect(readdirSync(join(dir, '.tmp'))).toEqual([]));
      expect(content.get(digestOf(MP4))).toBeNull();
    } finally {
      await new Promise<void>(r => server.close(() => r()));
    }
  });
});
