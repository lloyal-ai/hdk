import type { IncomingMessage, ServerResponse } from 'node:http';
import { representationsOf, sourceOf, DIGEST_PATTERN, MANIFEST_TYPE, type Attachment } from '@lloyal-labs/media';
import type { AttachmentStore, Descriptor } from '@lloyal-labs/media';

// ─────────────────────────────────────────────────────────────────
// The route table — what a path MEANS, resolved against the store.
// Below it sit ADAPTERS, one per way a renderer can reach the plane:
// `createContentRoutes` for an HTTP host, `protocol.handle` for a desktop
// scheme. The split is the same one the scheduler makes — decide, then enact —
// and it exists so that adding a route is a change HERE and nowhere else.
// ─────────────────────────────────────────────────────────────────

/** `decodeURIComponent` throws on a malformed escape; that is the client's
 *  input, not a server fault, so the caller answers 400 on `null`. */
const decodeURISegment = (s: string): string | null => {
  try { return decodeURIComponent(s); } catch { return null; }
};

/**
 * One request, reduced to what the route table actually reads.
 *
 * Not `IncomingMessage`: Electron's `protocol.handle` hands over a `Request`,
 * and neither shape is available to the other. Three fields is the whole
 * dependency, so taking them by value is what lets ONE table answer on a
 * socket and on a custom scheme without either knowing the other exists.
 *
 * @category Runtime
 */
export interface ContentRequest {
  method: string;
  /** Path ONLY — the adapter strips any query string. */
  path: string;
  /** The `If-None-Match` header verbatim, when the client sent one. */
  ifNoneMatch?: string;
}

/**
 * One answer, in the shape every transport can write.
 *
 * Deliberately NOT a union over outcome kind. A 404 and a 200 are the same
 * concern — a status, headers, and possibly bytes — differing only in value;
 * splitting them would make every adapter branch on a distinction it does not
 * act on. `body` absent means send none: a HEAD, or a 304. `headers` still
 * carries `Content-Length` in that case, because HEAD must declare the length
 * of the body it is not sending.
 *
 * CORS headers are NOT here. They are transport policy — an HTTP host has a
 * configured origin, a custom scheme's requests arrive with none — whereas
 * everything in this shape describes the CONTENT and is byte-identical
 * wherever it is served. Each adapter adds its own.
 *
 * @category Runtime
 */
export interface ContentReply {
  status: number;
  headers: Record<string, string>;
  body?: Uint8Array;
}

/**
 * Whether a path belongs to the content plane at all.
 *
 * The ONE place that answers it, so an adapter can decline a request before
 * doing any transport work and cannot drift from what {@link resolveContent}
 * will accept.
 *
 * @category Runtime
 */
export const isContentPath = (path: string): boolean =>
  path.startsWith('/v1/media/') || path.startsWith('/v1/content/');

const encoder = new TextEncoder();

/**
 * Caching headers for a content-addressed blob.
 *
 * `private` because project media is a tenant's own content and has no place
 * in a shared or CDN cache. `immutable` alone does not establish freshness —
 * it only promises the body will not change — so it rides with an explicit
 * `max-age`. The digest IS the validator, so it doubles as the `ETag` and
 * makes conditional requests exact rather than heuristic. `nosniff` matters
 * more here than usual: these are user-supplied bytes served under a type we
 * sniffed, and a browser guessing something executable from them is the
 * failure to prevent.
 */
const contentHeaders = (digest: string, extra: Record<string, string> = {}): Record<string, string> => ({
  'Cache-Control': 'private, max-age=31536000, immutable',
  'ETag': `"${digest}"`,
  'X-Content-Type-Options': 'nosniff',
  ...extra,
});

/** An error as a reply. The message travels as JSON so a client is told WHICH
 *  limit or which route it hit, rather than being left to infer it from a bare
 *  status — the ingress deadline test reads exactly this. */
const contentError = (status: number, message: string): ContentReply => {
  const body = encoder.encode(JSON.stringify({ error: message }));
  return {
    status,
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.byteLength) },
    body,
  };
};

/** Resolve one descriptor to its bytes, honouring the conditional request. */
const serveBlob = (
  store: AttachmentStore, req: ContentRequest, d: Descriptor,
): ContentReply => {
  // A client holding this exact digest already has the only body it can be.
  if (req.ifNoneMatch === `"${d.digest}"`) return { status: 304, headers: contentHeaders(d.digest) };
  const bytes = store.get(d.digest);
  if (!bytes) return contentError(404, 'blob not in store');
  return {
    status: 200,
    headers: contentHeaders(d.digest, {
      'Content-Type': d.mediaType,
      'Content-Length': String(bytes.byteLength),
    }),
    body: bytes,
  };
};

/**
 * The content plane's read routes: HTTP carries bytes, the WebSocket carries
 * references.
 *
 * ```
 * GET  /v1/media/<manifest>                     the manifest itself, by digest
 * GET  /v1/media/<manifest>/config              its typed config blob (a document's sidecar; OCI's empty blob for an image)
 * GET  /v1/media/<manifest>/source              the original as supplied, when the ingest retained it
 * GET  /v1/media/<manifest>/representations/<i> the bytes the model actually saw
 * HEAD /v1/content/<digest>                     existence, for pre-flight dedupe
 * ```
 *
 * `null` means the path is not ours at all, so a host can compose this with
 * whatever else it serves. Every other outcome is a {@link ContentReply},
 * including 405 — a path under our prefixes is answered here, never passed on.
 *
 * **A digest is identity, not authorization.** These routes authenticate
 * nothing; they are safe only behind the loopback default, a fronting proxy,
 * or a scheme reachable solely from the app's own renderers. There is
 * deliberately no enumeration route — HEAD answers about a digest you already
 * hold, and never lists what the store contains.
 *
 * **The ingress is not here.** Every route above is a READ, fully answerable
 * from the store. An upload is a WRITE, and both its bytes and its limits come
 * from the transport: a byte cap and a deadline on an HTTP host, a hand-off to
 * whichever process owns the store on a desktop scheme. So each adapter serves
 * `POST /v1/media/ingress` itself, under that same path — which is what lets a
 * client derive the ingress from its origin exactly as it derives the reads,
 * and stay ignorant of which target it is on. A marked door, not an oversight.
 *
 * **Nothing thrown here may escape.** A handler that threw inside a server's
 * `request` emit would become an uncaught exception and take the whole process
 * down — the resident model and every live Session with it. The `catch` is
 * here rather than in each adapter so that every adapter inherits it.
 *
 * @category Runtime
 */
export function resolveContent(req: ContentRequest, store: AttachmentStore): ContentReply | null {
  if (!isContentPath(req.path)) return null;
  let reply: ContentReply;
  try {
    reply = route(req, store);
  } catch (e) {
    reply = contentError(500, e instanceof Error ? e.message : 'content route failed');
  }
  // A HEAD answer carries no body — not even an error's. The headers are left
  // exactly as they are, `Content-Length` included, because they describe the
  // body a GET would return. Enforced HERE rather than at each route so no
  // branch can forget, and so an adapter that builds a real response object
  // (a desktop `Response`) cannot expose what an HTTP server would have
  // silently dropped for it.
  return req.method === 'HEAD' && reply.body ? { ...reply, body: undefined } : reply;
}

/** The routes themselves. Throwing is allowed — {@link resolveContent} contains
 *  it — and every answer here is unconditional about the body; HEAD is applied
 *  once, above. */
function route(req: ContentRequest, store: AttachmentStore): ContentReply {
  const { path, method } = req;
  // HEAD /v1/content/<digest> — existence only. Answers about a digest the
  // caller already holds; it never reveals what else is stored.
  //
  // HEAD-ONLY, deliberately. GET was accepted here and answered 200 with a
  // `Content-Length` and an empty body — a protocol violation. The fix is
  // to refuse GET rather than to serve the bytes: this route addresses raw
  // blobs by digest, so serving them would hand out any blob including a
  // retained SOURCE layer, defeating the reason
  // `/v1/media/<manifest>/representations/<i>` resolves through the
  // manifest at all. Bytes have exactly one door, and it is that one.
  const exists = /^\/v1\/content\/([^/]+)$/.exec(path);
  if (exists && method === 'HEAD') {
    const digest = decodeURISegment(exists[1]);
    if (digest === null || !DIGEST_PATTERN.test(digest)) return contentError(400, 'malformed digest');
    // Reads the WHOLE blob to answer a yes/no question, because
    // `AttachmentStore` offers no `size`/`has`. On the one route whose
    // purpose is to AVOID moving bytes, a dedupe pre-flight against an
    // 8 MiB image costs 8 MiB resident. Adding `size(digest)` beside `get`
    // belongs with the store-contract phase, not here.
    const bytes = store.get(digest);
    if (!bytes) return contentError(404, 'not found');
    return { status: 200, headers: contentHeaders(digest, { 'Content-Length': String(bytes.byteLength) }) };
  }

  // GET /v1/media/<manifest>/representations/<index> — the bytes the model
  // actually saw. Resolves THROUGH the manifest and only over its
  // representations, so a source layer can never be served by mistake.
  const rep = /^\/v1\/media\/([^/]+)\/representations\/(\d+)$/.exec(path);
  if (rep && (method === 'GET' || method === 'HEAD')) {
    const digest = decodeURISegment(rep[1]);
    if (digest === null || !DIGEST_PATTERN.test(digest)) return contentError(400, 'malformed digest');
    const manifest = store.getManifest(digest);
    if (!manifest) return contentError(404, 'no such attachment manifest');
    const reps = representationsOf(manifest);
    const i = Number(rep[2]);
    if (!Number.isInteger(i) || i < 0 || i >= reps.length) {
      return contentError(404, `representation ${i} of ${reps.length}`);
    }
    return serveBlob(store, req, reps[i]);
  }

  // GET /v1/media/<manifest> — the manifest itself, by digest. A manifest is
  // a blob, and serving it by digest is what any OCI reader expects; it is
  // how a UI learns what an attachment IS (its config media type) and what
  // roots it names, without a "kind" field anywhere on the wire.
  const man = /^\/v1\/media\/([^/]+)$/.exec(path);
  if (man && (method === 'GET' || method === 'HEAD')) {
    const digest = decodeURISegment(man[1]);
    if (digest === null || !DIGEST_PATTERN.test(digest)) return contentError(400, 'malformed digest');
    if (!store.getManifest(digest)) return contentError(404, 'no such attachment manifest');
    return serveBlob(store, req, { mediaType: MANIFEST_TYPE, digest, size: 0 });
  }

  // GET /v1/media/<manifest>/config — the typed config blob, resolved
  // THROUGH the manifest the way representations are. A document's
  // sidecar lives here; an image's config is OCI's canonical empty blob.
  const cfg = /^\/v1\/media\/([^/]+)\/config$/.exec(path);
  if (cfg && (method === 'GET' || method === 'HEAD')) {
    const digest = decodeURISegment(cfg[1]);
    if (digest === null || !DIGEST_PATTERN.test(digest)) return contentError(400, 'malformed digest');
    const manifest = store.getManifest(digest);
    if (!manifest) return contentError(404, 'no such attachment manifest');
    return serveBlob(store, req, manifest.config);
  }

  // GET /v1/media/<manifest>/source — the original as supplied, when the
  // ingest retained it: a document's PDF, an image before normalization.
  // Resolved THROUGH the manifest by ROLE, never by a blob digest a
  // client typed — raw blobs stay HEAD-only.
  const src = /^\/v1\/media\/([^/]+)\/source$/.exec(path);
  if (src && (method === 'GET' || method === 'HEAD')) {
    const digest = decodeURISegment(src[1]);
    if (digest === null || !DIGEST_PATTERN.test(digest)) return contentError(400, 'malformed digest');
    const manifest = store.getManifest(digest);
    if (!manifest) return contentError(404, 'no such attachment manifest');
    const source = sourceOf(manifest);
    if (!source) return contentError(404, 'no source retained for this attachment');
    return serveBlob(store, req, source);
  }

  return contentError(405, 'unsupported method or path');
}

// ─────────────────────────────────────────────────────────────────
// The HTTP adapter — the route table on a Node `http.Server`, plus the one
// route that cannot live in the table: an upload, whose bytes and whose
// limits belong to the transport.
// ─────────────────────────────────────────────────────────────────

/** Thrown when a body exceeds the cap, so the caller can answer 413 rather
 *  than a bare connection reset — a client that sends too much deserves to be
 *  told which limit it hit. */
class TooLarge extends Error {}

/** 8 MiB. Generous for an image, small enough that a stray POST cannot exhaust
 *  the host. Video ingress will not reuse this number — it needs resumable
 *  transfer, not a bigger ceiling. */
const DEFAULT_MAX_UPLOAD = 8 * 1024 * 1024;

/** 30s. Long enough for 8 MiB on a slow connection, short enough that a stalled
 *  upload does not hold a handler for the life of the process. */
const DEFAULT_UPLOAD_TIMEOUT_MS = 30_000;

/** Thrown when an upload outruns {@link ContentRoutesOpts.uploadTimeoutMs}. */
class TooSlow extends Error {}

/**
 * @category Runtime
 */
export interface ContentRoutesOpts {
  /** The project's content store. Reads resolve through it; nothing else. */
  store: AttachmentStore;
  /**
   * Normalize, commit, and return the root descriptor for an upload.
   *
   * Injected because the HTTP layer must not decide what "admitted" means, and
   * because normalization is a native dependency (`sharp`) that a harness
   * accepting no media should never load. **Absent ⇒ POST answers 501.** It
   * deliberately does NOT fall back to committing the raw bytes: an upload
   * that skipped normalization is not admitted content, and storing it as
   * though it were would put unvalidated pixels behind a digest the fold
   * trusts.
   *
   * **Bytes only, no declared type.** This route used to forward the request's
   * `Content-Type` header — a value the client writes and nothing verifies —
   * as authority over content the client did not produce. The bytes answer
   * that question, and the ingress is where they are decoded.
   */
  ingest?: (bytes: Uint8Array, signal?: AbortSignal) => Promise<Attachment>;
  /** Ceiling on a single upload body. @default 8 MiB — sized for an image. A
   *  host that installs the content ingress passes `MAX_DOCUMENT_BYTES` from
   *  `@lloyal-labs/media/node` beside `DOCUMENT_UPLOAD_TIMEOUT_MS`, so every
   *  host that mounts the plane admits the same. */
  maxUploadBytes?: number;
  /**
   * Ceiling on how long one upload may take, end to end.
   *
   * One deadline spans body transfer AND ingress: the signal handed to
   * `ingest` aborts at the same ceiling, so a completed body cannot hold the
   * handler while normalization queues behind other work. (A decode already
   * inside sharp has no abort — the 408 still goes out at the deadline; only
   * that decode runs on.)
   *
   * A byte cap alone does not bound a request: a client that opens a POST and
   * then trickles — or sends nothing at all — holds the promise, the socket and
   * the handler open indefinitely, and enough of them starve the host without
   * ever exceeding a single limit. Total duration rather than idle time,
   * because an idle timer is reset by exactly the one byte a slow-loris sends.
   *
   * @default 30s
   */
  uploadTimeoutMs?: number;
  /**
   * Exact origin permitted to call these routes cross-origin, e.g.
   * `http://localhost:5173`. Omitted ⇒ NO CORS headers at all, which is the
   * right default: in development Vite proxies content so requests stay
   * same-origin, and `*` on a route that serves a tenant's uploads is not a
   * default anyone should inherit.
   */
  allowedOrigin?: string;
}

/**
 * Read a request body bounded in BOTH bytes and time, settling exactly once.
 *
 * Module-level rather than a closure inside the router: it knows nothing about
 * digests, manifests or content, and lived inside the route factory only to
 * capture two numbers. Out here it is independently testable, and the router
 * is a router again instead of four regex branches wrapped around a promise
 * state machine.
 *
 * Two independent limits, because they fail differently. `maxBytes` is checked
 * against the DECLARED `Content-Length` and again against the real stream — a
 * client may lie, so the stream is the authority. `timeoutMs` is TOTAL
 * duration, not idle time: an idle timer is reset by exactly the one byte a
 * slow-loris sends.
 *
 * Every path here can fire more than once — `data` keeps emitting after the cap
 * is hit, `error` can follow `aborted` — so `settle` runs once and always
 * clears the timer with it.
 */
function readBounded(
  req: IncomingMessage,
  limits: { maxBytes: number; timeoutMs: number },
): Promise<Uint8Array> {
  const { maxBytes, timeoutMs } = limits;
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new TooLarge(`upload exceeds ${maxBytes} bytes`));
      return;
    }
    const chunks: Buffer[] = [];
    let seen = 0;
    let done = false;
    const settle = (f: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      f();
    };
    const timer = setTimeout(
      () => settle(() => reject(new TooSlow(`upload exceeded ${timeoutMs}ms`))),
      timeoutMs,
    );
    // `unref` so a pending upload timer never by itself keeps the process
    // alive; the socket is what should hold it open, not our clock.
    timer.unref?.();
    req.on('data', (c: Buffer) => {
      if (done) return;
      seen += c.length;
      if (seen > maxBytes) {
        // Stop reading but do NOT destroy yet: the response has to reach the
        // client first, or it sees a reset with no explanation.
        req.pause();
        settle(() => reject(new TooLarge(`upload exceeds ${maxBytes} bytes`)));
        return;
      }
      chunks.push(c);
    });
    // A client that disconnects mid-upload must settle this promise, or the
    // handler leaks a pending await for the life of the process.
    req.on('aborted', () => settle(() => reject(new Error('upload aborted'))));
    req.on('error', (e) => settle(() => reject(e)));
    req.on('end', () => settle(() => resolve(new Uint8Array(Buffer.concat(chunks)))));
  });
}

/**
 * Mount the content plane on a Node `http.Server`, beside a `WebSocketServer`.
 *
 * Returns a predicate — true when it handled the request — so a host can
 * compose it with whatever else it serves. The reads are
 * {@link resolveContent}'s; this adds the three things that are HTTP's own:
 * CORS, the preflight, and `POST /v1/media/ingress`.
 *
 * @category Runtime
 */
export function createContentRoutes(
  opts: ContentRoutesOpts,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const maxUpload = opts.maxUploadBytes ?? DEFAULT_MAX_UPLOAD;
  const uploadTimeout = opts.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;

  /** CORS headers, added only when an origin is configured. See `allowedOrigin`. */
  const cors = (h: Record<string, string>): Record<string, string> =>
    opts.allowedOrigin
      ? { ...h, 'Access-Control-Allow-Origin': opts.allowedOrigin, 'Vary': 'Origin' }
      : h;

  const send = (res: ServerResponse, reply: ContentReply): void => {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(reply.status, cors(reply.headers));
    if (reply.body) res.end(Buffer.from(reply.body)); else res.end();
  };

  const fail = (res: ServerResponse, code: number, message: string): void =>
    send(res, contentError(code, message));

  return (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (!isContentPath(path)) return false;

    // Contained here so a route failure cannot reach the server's `request`
    // emit and kill the process. `resolveContent` keeps its own; this covers
    // the upload branch, which is ours.
    try {
      const method = req.method ?? 'GET';

      // The preflight is CORS, and CORS is this adapter's business: a custom
      // scheme negotiates it in the browser, with no preflight to answer.
      if (method === 'OPTIONS') {
        send(res, { status: 204, headers: {
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        } });
        return true;
      }

      // POST /v1/media/ingress — bytes in, root descriptor out. Ahead of the
      // route table because the table answers 405 for it: an upload is a
      // write, and the table only reads.
      if (path === '/v1/media/ingress' && method === 'POST') {
        if (!opts.ingest) {
          fail(res, 501, 'no ingress service installed on this host');
          return true;
        }
        // ONE deadline for transfer AND ingress, and it wins the race: it
        // aborts the signal and REJECTS, so a decode that ignores the signal
        // (sharp, once inside) cannot hold the response past the ceiling. The
        // late result of such a decode is discarded, never written.
        const ctrl = new AbortController();
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            ctrl.abort();
            reject(new TooSlow(`upload exceeded ${uploadTimeout}ms end to end`));
          }, uploadTimeout);
        });
        Promise.race([
          readBounded(req, { maxBytes: maxUpload, timeoutMs: uploadTimeout })
            .then((bytes) => opts.ingest!(bytes, ctrl.signal)),
          deadline,
        ])
          .then((descriptor) => {
            const body = JSON.stringify(descriptor);
            send(res, {
              status: 201,
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(body)),
              },
              body: encoder.encode(body),
            });
          })
          .catch((e: unknown) => {
            const tooLarge = e instanceof TooLarge;
            const tooSlow = e instanceof TooSlow || ctrl.signal.aborted;
            // A full normalization queue is overload: retryable, not a client
            // fault and not ours. `EBUSY` is the errno the ingress sets for it.
            const busy = typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'EBUSY';
            // The ingress's own time bound is the same class as a slow upload.
            const timedOut = typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ETIMEDOUT';
            // An error carrying a syscall came from the filesystem under the
            // store — disk full, read-only volume. That is ours, not the client's.
            const ours = typeof e === 'object' && e !== null && typeof (e as { syscall?: unknown }).syscall === 'string';
            const code = tooLarge ? 413 : (tooSlow || timedOut) ? 408 : busy ? 503 : ours ? 500 : 400;
            fail(res, code, e instanceof Error ? e.message : 'ingress failed');
            // Now that the status is on the wire, stop the upload. A stalled
            // client will not close on its own — that is the whole problem —
            // so the timeout path has to drop the socket just as the cap does.
            if (tooLarge || tooSlow) req.destroy();
          })
          .finally(() => clearTimeout(timer));
        return true;
      }

      // `isContentPath` already passed, so this is never null.
      send(res, resolveContent({
        method,
        path,
        ifNoneMatch: req.headers['if-none-match'],
      }, opts.store)!);
      return true;
    } catch (e) {
      fail(res, 500, e instanceof Error ? e.message : 'content route failed');
      return true;
    }
  };
}
