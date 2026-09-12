/**
 * The content plane's route table, with no transport under it.
 *
 * `content-routes.test.ts` drives the same routes over a real socket and must
 * keep passing unchanged — that pair is the point. What this file guards is
 * the thing the socket hides: that a path's MEANING is answered from the store
 * alone, so a second adapter (a desktop `attachment://` scheme, which opens no
 * port at all) serves byte-identical content without reimplementing a route.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAttachmentStore } from '@lloyal-labs/media/node';
import type { AttachmentStore } from '@lloyal-labs/media';
import { resolveContent, isContentPath } from '../src/content-routes';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 9, 9, 9]);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lloyal-resolve-'));
  const store = new FileAttachmentStore(dir);
  const rep = store.putBlob(PNG, 'image/png');
  const source = store.putBlob(JPEG, 'image/jpeg');
  const root = store.putAttachment({ representations: [rep], source });
  return { dir, store, root, rep, source };
}

const json = (body?: Uint8Array): unknown =>
  JSON.parse(new TextDecoder().decode(body ?? new Uint8Array()));

describe('resolveContent — the route table alone', () => {
  it('declines a foreign path and OWNS every path under its prefixes', () => {
    const { store } = fixture();
    // `null` is the adapter's early-out: the host still has its own routes.
    expect(resolveContent({ method: 'GET', path: '/anything-else' }, store)).toBeNull();
    expect(resolveContent({ method: 'GET', path: '/v1/media' }, store)).toBeNull();
    expect(isContentPath('/v1/media')).toBe(false);

    // Inside the prefix, an unknown shape is ANSWERED (405), never handed back
    // as unclaimed — which is what keeps "there is no listing route" true
    // rather than accidentally delegating `/v1/content/` to the host.
    expect(resolveContent({ method: 'GET', path: '/v1/content/' }, store)?.status).toBe(405);
    expect(isContentPath('/v1/content/')).toBe(true);
  });

  it('HEAD declares the length of the body it does not send; GET sends it', () => {
    const { store, root } = fixture();
    const path = `/v1/media/${root.digest}/representations/0`;

    const get = resolveContent({ method: 'GET', path }, store)!;
    expect(get.status).toBe(200);
    expect(get.body).toEqual(PNG);
    expect(get.headers['Content-Length']).toBe(String(PNG.byteLength));

    const head = resolveContent({ method: 'HEAD', path }, store)!;
    expect(head.status).toBe(200);
    expect(head.body).toBeUndefined();
    // Same declared length, no body — the distinction the HTTP layer used to
    // get wrong on the existence route.
    expect(head.headers['Content-Length']).toBe(String(PNG.byteLength));
    expect(head.headers['ETag']).toBe(get.headers['ETag']);
  });

  it('answers 304 on an exact digest match, with no body', () => {
    const { store, root, rep } = fixture();
    const reply = resolveContent({
      method: 'GET',
      path: `/v1/media/${root.digest}/representations/0`,
      ifNoneMatch: `"${rep.digest}"`,
    }, store)!;
    expect(reply.status).toBe(304);
    expect(reply.body).toBeUndefined();
    expect(reply.headers['ETag']).toBe(`"${rep.digest}"`);
  });

  it('carries its errors as a readable JSON body, not a bare status', () => {
    const { store } = fixture();
    const bad = resolveContent({ method: 'GET', path: '/v1/media/notadigest' }, store)!;
    expect(bad.status).toBe(400);
    expect(json(bad.body)).toEqual({ error: 'malformed digest' });
    expect(bad.headers['Content-Type']).toBe('application/json');
    expect(bad.headers['Content-Length']).toBe(String(bad.body!.byteLength));
  });

  it('never puts a body on a HEAD — not even an error\'s — and keeps the headers', () => {
    const { store } = fixture();
    // An HTTP server strips a HEAD body on the way out, which is why this went
    // unnoticed: a desktop adapter builds a real `Response` and would hand the
    // bytes over. The table has to be right rather than lucky.
    const expected = new TextEncoder().encode(JSON.stringify({ error: 'malformed digest' })).byteLength;
    const bad = resolveContent({ method: 'HEAD', path: '/v1/content/notadigest' }, store)!;
    expect(bad.status).toBe(400);
    expect(bad.body).toBeUndefined();
    // The length still describes the body a GET would have returned.
    expect(bad.headers['Content-Length']).toBe(String(expected));

    const missing = resolveContent({ method: 'HEAD', path: `/v1/media/sha256:${'0'.repeat(64)}` }, store)!;
    expect(missing.status).toBe(404);
    expect(missing.body).toBeUndefined();
  });

  it('emits no CORS header — that is the adapter\'s policy, not the content\'s', () => {
    const { store, root } = fixture();
    const reply = resolveContent({ method: 'GET', path: `/v1/media/${root.digest}` }, store)!;
    // A second adapter must not silently inherit an HTTP host's configured
    // origin, so the table never names one.
    expect(Object.keys(reply.headers).map((k) => k.toLowerCase()))
      .not.toContain('access-control-allow-origin');
  });

  it('never throws at its caller — a failing store becomes a 500 reply', () => {
    // In an HTTP server a throw here would reach the `request` emit and take
    // the process down: the resident model and every live Session with it.
    // A desktop `protocol.handle` is no safer, so the guard lives in the table.
    const exploding = {
      get: () => { throw new Error('EIO: disk read failed'); },
      getManifest: () => { throw new Error('EIO: disk read failed'); },
    } as unknown as AttachmentStore;
    const reply = resolveContent({
      method: 'GET', path: `/v1/media/sha256:${'a'.repeat(64)}`,
    }, exploding)!;
    expect(reply.status).toBe(500);
    expect(json(reply.body)).toEqual({ error: 'EIO: disk read failed' });
  });

  it('keeps the source unreachable except by role, transport or not', () => {
    const { store, root, source } = fixture();
    // The source is a layer of the same manifest but never a representation.
    expect(resolveContent({ method: 'GET', path: `/v1/media/${root.digest}/representations/1` }, store)?.status).toBe(404);
    // A raw blob digest is not a manifest.
    expect(resolveContent({ method: 'GET', path: `/v1/media/${source.digest}/representations/0` }, store)?.status).toBe(404);
    // And raw blobs stay HEAD-only: GET on the existence route is refused.
    expect(resolveContent({ method: 'GET', path: `/v1/content/${source.digest}` }, store)?.status).toBe(405);
    // By ROLE, through the manifest, it is served — under its own media type.
    const byRole = resolveContent({ method: 'GET', path: `/v1/media/${root.digest}/source` }, store)!;
    expect(byRole.status).toBe(200);
    expect(byRole.headers['Content-Type']).toBe('image/jpeg');
    expect(byRole.body).toEqual(JPEG);
  });

  it('refuses an upload: the table only reads', () => {
    const { store } = fixture();
    // The ingress needs bytes and limits only a transport can supply, so it
    // lives with the adapter that carries them. Desktop does not use an HTTP
    // route for it at all.
    expect(resolveContent({ method: 'POST', path: '/v1/media/ingress' }, store)?.status).toBe(405);
  });
});
