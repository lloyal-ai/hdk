/**
 * The content plane on a desktop: a custom scheme, not a port.
 *
 * A loopback server would be reachable by every process on the machine, and
 * these routes authenticate nothing by design — a digest is identity, not
 * authorization. `attachment://` is reachable only from this app's own
 * renderers and opens no socket at all. The routes are rig's `resolveContent`,
 * the same table the served host answers over HTTP, so a route added there
 * arrives here for free and the two targets cannot answer one URL differently.
 *
 * @category Desktop
 */
import { protocol } from 'electron';
import { BlobUploads, createProjectMediaStore, isDistributionPath, MAX_UPLOAD_CHUNK_BYTES, resolveContent } from '@lloyal-labs/rig/node';
import type { ContentReply } from '@lloyal-labs/rig/node';
import { MAX_DOCUMENT_BYTES, DOCUMENT_UPLOAD_TIMEOUT_MS } from '@lloyal-labs/media/node';
import type { AttachmentStore, Descriptor } from '@lloyal-labs/media';
import { readBounded, TooLarge, TooSlow } from './read-bounded';

/** The scheme's authority: `standard` schemes require one. Every route lives under the path, as on HTTP. */
export const CONTENT_ORIGIN = 'attachment://store';

/**
 * Must run BEFORE app ready — afterwards the registration is ignored SILENTLY.
 * All four privileges are load-bearing: `standard` gives the scheme an origin
 * so CSP can name it, `secure` keeps it out of the mixed-content rules,
 * `supportFetchAPI` lets `fetch` address it, and without `corsEnabled` the
 * scheme takes no part in CORS at all, so the handler's allow-origin header
 * is never consulted and every fetch fails before reaching it.
 */
export function registerContentScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'attachment', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  ]);
}

/**
 * Serve reads from the project store; hand an upload to `ingest`. Reading needs
 * no lock: OCI blobs are content-addressed and immutable. A staged upload is
 * the same: adopting one writes a content-addressed blob by atomic rename and
 * touches no manifest or index, so the scheme stages originals over its own
 * view of the store. Ingest is not ours — it normalizes and commits manifests,
 * so it belongs to whichever process owns the store, and takes a signal so a
 * deadline here can actually stop it.
 */
export function serveContentScheme(
  projectRoot: string,
  ingest: (bytes: Uint8Array, signal: AbortSignal) => Promise<Descriptor>,
): void {
  const media = createProjectMediaStore(projectRoot);
  const handle = contentHandler({ store: media, uploads: new BlobUploads(media, media), ingest });
  protocol.handle('attachment', handle);
}

/**
 * The scheme's answer to one request, as a plain `Request` → `Response`: the
 * content plane's route table, its one single-payload write, and the blob
 * upload surface, each under the same bounds the served host applies.
 *
 * @category Desktop
 */
export function contentHandler(deps: {
  store: AttachmentStore;
  uploads: BlobUploads;
  ingest: (bytes: Uint8Array, signal: AbortSignal) => Promise<Descriptor>;
}): (request: Request) => Promise<Response> {
  const { store, uploads, ingest } = deps;
  // The renderer is cross-origin to this scheme — a dev server in development,
  // `file://` in a build — so it has no origin to echo. `*` grants nothing
  // further: only this app's own renderers can address the scheme.
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': EXPOSED_HEADERS };
  const respond = (reply: ContentReply): Response =>
    new Response((reply.stream ?? reply.body ?? null) as BodyInit | null, { status: reply.status, headers: { ...reply.headers, ...cors } });

  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;

    // The plane's one WRITE, and the only route not answerable from the store.
    if (request.method === 'POST' && path === '/v1/media/ingress') {
      // ONE deadline over BOTH halves — the transfer and the ingest — and the same bounds the served host
      // passes its route, so both targets admit the same thing.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), DOCUMENT_UPLOAD_TIMEOUT_MS);
      try {
        const declared = Number(request.headers.get('content-length') ?? NaN);
        if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES) throw new TooLarge(`upload exceeds ${MAX_DOCUMENT_BYTES} bytes`);
        const bytes = await readBounded(request.body, MAX_DOCUMENT_BYTES, ctrl.signal);
        const root = await ingest(bytes, ctrl.signal);
        return Response.json(root, { status: 201, headers: cors });
      } catch (err) {
        // The same statuses the HTTP route answers with: 413 too large, 408 too slow, else refused.
        const late = err instanceof TooSlow || ctrl.signal.aborted;
        const status = err instanceof TooLarge ? 413 : late ? 408 : 400;
        const error = late
          ? `upload exceeded ${DOCUMENT_UPLOAD_TIMEOUT_MS}ms end to end`
          : err instanceof Error ? err.message : 'ingest failed';
        return Response.json({ error }, { status, headers: cors });
      } finally {
        clearTimeout(timer);
      }
    }

    // An original's chunks: each read under the chunk bound and the upload deadline, then the session table.
    if (isDistributionPath(path)) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), DOCUMENT_UPLOAD_TIMEOUT_MS);
      try {
        const carriesBody = request.method === 'POST' || request.method === 'PATCH' || request.method === 'PUT';
        const body = carriesBody ? await readBounded(request.body, MAX_UPLOAD_CHUNK_BYTES, ctrl.signal) : undefined;
        const contentRange = request.headers.get('content-range');
        const range = request.headers.get('range');
        return respond(uploads.resolve({
          method: request.method, path, query: url.searchParams,
          ...(contentRange ? { contentRange } : {}),
          ...(range ? { range } : {}),
          ...(body && body.byteLength > 0 ? { body } : {}),
        })!);
      } catch (err) {
        const status = err instanceof TooLarge ? 413 : err instanceof TooSlow || ctrl.signal.aborted ? 408 : 400;
        return Response.json({ error: err instanceof Error ? err.message : 'upload failed' }, { status, headers: cors });
      } finally {
        clearTimeout(timer);
      }
    }

    const range = request.headers.get('range');
    const reply = resolveContent({
      method: request.method, path,
      ifNoneMatch: request.headers.get('if-none-match') ?? undefined,
      ...(range ? { range } : {}),
    }, store);
    if (!reply) return new Response(null, { status: 404 });
    return respond(reply);
  };
}

/** Headers a renderer must be allowed to read: where its upload went, how far it got, and which part of a blob it was sent. */
const EXPOSED_HEADERS = 'Location, Range, Content-Range, Accept-Ranges, Docker-Upload-UUID, Docker-Content-Digest';
