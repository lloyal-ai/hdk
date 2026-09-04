/**
 * The content plane: HTTP carries bytes, the WebSocket carries references.
 *
 * The failure this guards is not a crash — it is media bytes finding their way
 * back onto a JSON command frame, or a route resolving something the model
 * never saw (a source layer instead of the admitted representation).
 */
import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { FileAttachmentStore } from '@lloyal-labs/media/node';
import { createContentRoutes } from '../src/content-routes';
import type { Attachment } from '@lloyal-labs/media';

/** A fabricated ROOT for ingress fakes — branded here, once, so a fake cannot
 *  hand the route a bare descriptor by accident (the contract the route keeps). */
const fakeRoot = (digest: string, size: number): Attachment =>
  ({ mediaType: 'image/png', digest, size }) as Attachment;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 9, 9, 9]);

/** A store holding one attachment: a normalized representation plus the source
 *  it came from — the shape that makes "never serve the source" testable. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lloyal-routes-'));
  const store = new FileAttachmentStore(dir);
  const rep = store.putBlob(PNG, 'image/png', { 'ai.lloyal.derive.quality': '82' });
  const source = store.putBlob(JPEG, 'image/jpeg');
  const root = store.putAttachment({ representations: [rep], source });
  return { dir, store, root, rep, source };
}

async function withServer<T>(
  opts: Parameters<typeof createContentRoutes>[0],
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const routes = createContentRoutes(opts);
  const server: Server = createServer((req, res) => {
    if (routes(req, res)) return;
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('content routes', () => {
  it('answers a malformed percent escape with 400, never 500', async () => {
    const { store } = fixture();
    await withServer({ store }, async (base) => {
      // decodeURIComponent throws on these; that is client input, not a server fault.
      const head = await fetch(`${base}/v1/content/%`, { method: 'HEAD' });
      expect(head.status).toBe(400);
      const rep = await fetch(`${base}/v1/media/%/representations/0`);
      expect(rep.status).toBe(400);
    });
  });

  it('sends 408 at the deadline even when the ingress ignores its signal', async () => {
    const { store } = fixture();
    await withServer(
      // An ingress that never settles and never looks at the signal — a decode
      // already inside sharp behaves exactly like this.
      { store, uploadTimeoutMs: 150, ingest: () => new Promise(() => {}) },
      async (base) => {
        const res = await fetch(`${base}/v1/media/ingress`, {
          method: 'POST', body: PNG, signal: AbortSignal.timeout(3_000),
        });
        expect(res.status).toBe(408);
      },
    );
  });

  it('the ingress contract returns an attachment ROOT, not any descriptor (type-level)', () => {
    const plain = { mediaType: 'image/png', digest: 'sha256:' + '0'.repeat(64), size: 1 };
    // @ts-expect-error a bare Descriptor must not satisfy `ingest` — only a manifest root may come back
    const routes = createContentRoutes({ store: fixture().store, ingest: async () => plain });
    expect(typeof routes).toBe('function');
  });

  it('serves the admitted representation, never the source', async () => {
    const { store, root, source } = fixture();
    await withServer({ store }, async (base) => {
      const res = await fetch(`${base}/v1/media/${root.digest}/representations/0`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);

      // The source is a layer of the same manifest, but it is NOT a
      // representation — the model never saw it, so this route must not reach
      // it under any index.
      expect((await fetch(`${base}/v1/media/${root.digest}/representations/1`)).status).toBe(404);
      // Nor is the source's own digest addressable as a manifest.
      expect((await fetch(`${base}/v1/media/${source.digest}/representations/0`)).status).toBe(404);
    });
  });

  it('never serves drifted bytes under their digest — a corrupted blob is 404, not a false ETag', async () => {
    const { dir, store, root, rep } = fixture();
    // The digest is the ETag and the cache key: bytes that no longer hash to
    // it must not go out under it. The store refuses them; the route says 404.
    writeFileSync(join(dir, 'blobs', 'sha256', rep.digest.slice('sha256:'.length)), new Uint8Array([9, 9, 9]));
    await withServer({ store }, async (base) => {
      const res = await fetch(`${base}/v1/media/${root.digest}/representations/0`);
      expect(res.status).toBe(404);
    });
  });

  it('caches privately, validates by digest, and refuses MIME sniffing', async () => {
    const { store, root, rep } = fixture();
    await withServer({ store }, async (base) => {
      const url = `${base}/v1/media/${root.digest}/representations/0`;
      const res = await fetch(url);
      const cc = res.headers.get('cache-control') ?? '';
      // `private`: a tenant's own media has no place in a shared or CDN cache.
      expect(cc).toContain('private');
      // `immutable` alone promises the body will not change, not freshness —
      // it needs an explicit max-age beside it.
      expect(cc).toContain('immutable');
      expect(cc).toMatch(/max-age=\d+/);
      // These are user-supplied bytes served under a sniffed type.
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      // The digest IS the validator, so conditional requests are exact.
      expect(res.headers.get('etag')).toBe(`"${rep.digest}"`);

      const again = await fetch(url, { headers: { 'If-None-Match': `"${rep.digest}"` } });
      expect(again.status).toBe(304);
      expect(await again.text()).toBe('');
    });
  });

  it('answers existence by digest without enumerating the store', async () => {
    const { store, rep } = fixture();
    await withServer({ store }, async (base) => {
      const hit = await fetch(`${base}/v1/content/${rep.digest}`, { method: 'HEAD' });
      expect(hit.status).toBe(200);
      expect(await hit.text()).toBe(''); // HEAD carries no body

      const miss = await fetch(`${base}/v1/content/sha256:${'b'.repeat(64)}`, { method: 'HEAD' });
      expect(miss.status).toBe(404);

      // There is deliberately no listing route.
      expect((await fetch(`${base}/v1/content/`)).status).toBe(405);
    });
  });

  it('rejects malformed digests and path traversal before touching the store', async () => {
    const { store } = fixture();
    await withServer({ store }, async (base) => {
      for (const bad of [
        'sha256:zzzz', 'sha512:' + 'a'.repeat(64), 'notadigest',
        encodeURIComponent('../../etc/passwd'),
        encodeURIComponent('sha256:' + 'a'.repeat(64) + '/../../x'),
      ]) {
        const res = await fetch(`${base}/v1/content/${bad}`, { method: 'HEAD' });
        expect([400, 404, 405]).toContain(res.status);
        expect(res.status).not.toBe(200);
      }
    });
  });

  it('refuses uploads with no ingress service rather than storing raw bytes', async () => {
    // Committing an un-normalized upload would put unvalidated pixels behind a
    // digest the fold trusts. 501 until normalization is injected.
    const { store } = fixture();
    await withServer({ store }, async (base) => {
      const res = await fetch(`${base}/v1/media/ingress`, {
        method: 'POST', body: PNG, headers: { 'Content-Type': 'image/png' },
      });
      expect(res.status).toBe(501);
    });
  });

  it('answers 413 on an oversize body instead of resetting the connection', async () => {
    const { store } = fixture();
    let seen: number | null = null;
    await withServer(
      { store, maxUploadBytes: 16, ingest: async (b) => { seen = b.byteLength; throw new Error('x'); } },
      async (base) => {
        const res = await fetch(`${base}/v1/media/ingress`, {
          method: 'POST', body: new Uint8Array(1024), headers: { 'Content-Type': 'image/png' },
        });
        expect(res.status).toBe(413);
        // The stream is the authority: ingest must never have run.
        expect(seen).toBeNull();
      },
    );
  });

  it('answers 503 when the ingress is busy, and keeps the connection', async () => {
    // A full normalization queue is overload, not a bad request and not a
    // server fault: 503 tells the client to retry, and the socket stays up.
    const { store } = fixture();
    await withServer(
      { store, ingest: async () => { throw Object.assign(new Error('normalizeImage: busy'), { code: 'EBUSY' }); } },
      async (base) => {
        const res = await fetch(`${base}/v1/media/ingress`, {
          method: 'POST', body: new Uint8Array(64), headers: { 'Content-Type': 'image/png' },
        });
        expect(res.status).toBe(503);
      },
    );
  });

  it('sends no CORS header unless an origin is configured', async () => {
    const { store, root } = fixture();
    const path = (r: { digest: string }) => `/v1/media/${r.digest}/representations/0`;
    await withServer({ store }, async (base) => {
      const res = await fetch(`${base}${path(root)}`);
      // `*` on a route serving a tenant's uploads is not a default to inherit.
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
    await withServer({ store, allowedOrigin: 'http://localhost:5173' }, async (base) => {
      const res = await fetch(`${base}${path(root)}`);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
      expect(res.headers.get('vary')).toBe('Origin');
    });
  });

  it('leaves non-content paths alone for the host to handle', async () => {
    const { store } = fixture();
    await withServer({ store }, async (base) => {
      expect((await fetch(`${base}/anything-else`)).status).toBe(404);
    });
  });

  it('bounds an upload in TIME, not only in bytes', async () => {
    const { store } = fixture();
    // A client that opens a POST, declares a modest length, and then never
    // sends the body. Under a byte cap alone this holds the handler, the
    // promise and the socket for the life of the process — enough of them
    // starve the host without any single limit being exceeded.
    await withServer(
      { store, ingest: async () => fakeRoot('sha256:' + '0'.repeat(64), 1), uploadTimeoutMs: 150 },
      async (base) => {
        const stalled = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([0x89]));   // one byte, then silence
          },
        });
        const res = await fetch(`${base}/v1/media/ingress`, {
          method: 'POST',
          headers: { 'content-type': 'image/png' },
          body: stalled,
          // @ts-expect-error undici-only: required to send a stream body
          duplex: 'half',
        });
        // 408, not 413 and not 400 — the client is told which limit it hit.
        expect(res.status).toBe(408);
        expect((await res.json() as { error: string }).error).toContain('150ms');
      },
    );
  }, 10_000);

  it('leaves a normal upload untouched by the timeout', async () => {
    const { store } = fixture();
    let ingested: Uint8Array | null = null;
    await withServer(
      {
        store,
        uploadTimeoutMs: 5_000,
        ingest: async (bytes) => {
          ingested = bytes;
          return fakeRoot('sha256:' + '1'.repeat(64), bytes.byteLength);
        },
      },
      async (base) => {
        const res = await fetch(`${base}/v1/media/ingress`, {
          method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG,
        });
        expect(res.status).toBe(201);
        expect(ingested).toEqual(PNG);
      },
    );
  });

  it('the deadline spans ingress, not only the body', async () => {
    // A completed body used to stop the clock: normalization then ran with
    // no signal and could hold the handler far beyond the configured
    // ceiling. One AbortController now spans both halves — an ingress that
    // honours its signal is cut off at the same deadline.
    const { store } = fixture();
    await withServer(
      {
        store,
        uploadTimeoutMs: 150,
        ingest: (_bytes, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('ingress aborted at deadline')));
          }),
      },
      async (base) => {
        const res = await fetch(`${base}/v1/media/ingress`, {
          method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG,
        });
        expect(res.status).toBe(408); // told which limit it hit, not a generic 400
      },
    );
  }, 10_000);

  it('refuses GET on the existence route — it is HEAD-only by design', async () => {
    // `/v1/content/<digest>` answers EXISTENCE. Serving its bytes would hand
    // out any blob by digest, including a retained SOURCE layer — defeating
    // the reason `/representations/<i>` resolves through the manifest at all.
    // Before this, GET was accepted and replied 200 with a `Content-Length`
    // and an EMPTY body: a protocol violation and a hole in the same breath.
    const { store, rep } = fixture();
    await withServer({ store }, async (base) => {
      const head = await fetch(`${base}/v1/content/${rep.digest}`, { method: 'HEAD' });
      expect(head.status).toBe(200);

      const get = await fetch(`${base}/v1/content/${rep.digest}`);
      expect(get.status).toBe(405);
      expect(new Uint8Array(await get.arrayBuffer()).byteLength).toBeGreaterThan(0); // a real error body
    });
  });

  it('declares a Content-Length that matches the body it sends', async () => {
    // Nothing in the repo asserted this — `content-length` appeared in zero
    // test assertions across every package — which is how a route that
    // declared N bytes and sent zero survived.
    const { store, root } = fixture();
    await withServer({ store }, async (base) => {
      const url = `${base}/v1/media/${root.digest}/representations/0`;

      const get = await fetch(url);
      const body = new Uint8Array(await get.arrayBuffer());
      expect(Number(get.headers.get('content-length'))).toBe(body.byteLength);

      // HEAD declares the same length and sends nothing — which is correct for
      // HEAD, and the exact shape the existence route was wrongly using for GET.
      const head = await fetch(url, { method: 'HEAD' });
      expect(Number(head.headers.get('content-length'))).toBe(body.byteLength);
      expect(new Uint8Array(await head.arrayBuffer()).byteLength).toBe(0);
    });
  });
});
