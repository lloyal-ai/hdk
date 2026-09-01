import type { IncomingMessage, ServerResponse } from 'node:http';
import { representationsOf, DIGEST_PATTERN } from '@lloyal-labs/media';
import type { AttachmentStore, Descriptor } from '@lloyal-labs/media';

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
  ingest?: (bytes: Uint8Array, signal?: AbortSignal) => Promise<Descriptor>;
  /** Ceiling on a single upload body. @default 8 MiB */
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
 * The content plane: HTTP carries bytes, the WebSocket carries references.
 *
 * Mount beside a `WebSocketServer` on ONE `http.Server`. Returns a predicate —
 * true when it handled the request — so a host can compose it with whatever
 * else it serves.
 *
 * ```
 * POST /v1/media/ingress                       upload → normalize → root descriptor
 * GET  /v1/media/<manifest>/representations/<i> the bytes the model actually saw
 * HEAD /v1/content/<digest>                     existence, for pre-flight dedupe
 * ```
 *
 * **A digest is identity, not authorization.** These routes authenticate
 * nothing; they are safe only behind the loopback default or a fronting proxy.
 * There is deliberately no enumeration route — HEAD answers about a digest you
 * already hold, and never lists what the store contains.
 *
 * **Nothing thrown here may escape.** A handler that throws inside the
 * server's `request` emit would become an uncaught exception and take the
 * whole process down — the resident model and every live Session with it. Same
 * reasoning as the driver's per-socket `error` handler.
 *
 * @category Runtime
 */
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

export function createContentRoutes(
  opts: ContentRoutesOpts,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const maxUpload = opts.maxUploadBytes ?? DEFAULT_MAX_UPLOAD;
  const uploadTimeout = opts.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;

  /** CORS headers, added only when an origin is configured. */
  const head = (extra: Record<string, string> = {}): Record<string, string> => {
    const h = { ...extra };
    // Only when explicitly configured. See `allowedOrigin`.
    if (opts.allowedOrigin) {
      h['Access-Control-Allow-Origin'] = opts.allowedOrigin;
      h['Vary'] = 'Origin';
    }
    return h;
  };

  const fail = (res: ServerResponse, code: number, message: string): void => {
    if (res.headersSent) { res.end(); return; }
    const body = JSON.stringify({ error: message });
    res.writeHead(code, head({
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
    }));
    res.end(body);
  };

  /** Read a bounded body, refusing early on a declared length that already
   *  exceeds the cap and again on the real bytes — a client may lie about
   *  `Content-Length`, so the stream is the authority. */

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
  const contentHeaders = (digest: string, extra: Record<string, string>): Record<string, string> =>
    head({
      'Cache-Control': 'private, max-age=31536000, immutable',
      'ETag': `"${digest}"`,
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    });

  /** A client holding this exact digest already has the only body it can be. */
  const fresh = (req: IncomingMessage, digest: string): boolean =>
    (req.headers['if-none-match'] ?? '') === `"${digest}"`;

  const serveBlob = (
    req: IncomingMessage, res: ServerResponse, d: Descriptor, bodyless: boolean,
  ): void => {
    if (fresh(req, d.digest)) {
      res.writeHead(304, contentHeaders(d.digest, {}));
      res.end();
      return;
    }
    const bytes = opts.store.get(d.digest);
    if (!bytes) { fail(res, 404, 'blob not in store'); return; }
    res.writeHead(200, contentHeaders(d.digest, {
      'Content-Type': d.mediaType,
      'Content-Length': String(bytes.byteLength),
    }));
    if (bodyless) res.end(); else res.end(Buffer.from(bytes));
  };

  return (req, res) => {
    const url = req.url ?? '';
    if (!url.startsWith('/v1/media/') && !url.startsWith('/v1/content/')) return false;

    // Contained here so a route failure cannot reach the server's `request`
    // emit and kill the process.
    try {
      const path = url.split('?')[0];
      const method = req.method ?? 'GET';

      if (method === 'OPTIONS') {
        res.writeHead(204, head({
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }));
        res.end();
        return true;
      }

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
        const digest = decodeURIComponent(exists[1]);
        if (!DIGEST_PATTERN.test(digest)) { fail(res, 400, 'malformed digest'); return true; }
        // Reads the WHOLE blob to answer a yes/no question, because
        // `AttachmentStore` offers no `size`/`has`. On the one route whose
        // purpose is to AVOID moving bytes, a dedupe pre-flight against an
        // 8 MiB image costs 8 MiB resident. Adding `size(digest)` beside `get`
        // belongs with the store-contract phase, not here.
        const bytes = opts.store.get(digest);
        if (!bytes) { fail(res, 404, 'not found'); return true; }
        res.writeHead(200, contentHeaders(digest, {
          'Content-Length': String(bytes.byteLength),
        }));
        res.end();
        return true;
      }

      // GET /v1/media/<manifest>/representations/<index> — the bytes the model
      // actually saw. Resolves THROUGH the manifest and only over its
      // representations, so a source layer can never be served by mistake.
      const rep = /^\/v1\/media\/([^/]+)\/representations\/(\d+)$/.exec(path);
      if (rep && (method === 'GET' || method === 'HEAD')) {
        const digest = decodeURIComponent(rep[1]);
        if (!DIGEST_PATTERN.test(digest)) { fail(res, 400, 'malformed digest'); return true; }
        const manifest = opts.store.getManifest(digest);
        if (!manifest) { fail(res, 404, 'no such attachment manifest'); return true; }
        const reps = representationsOf(manifest);
        const i = Number(rep[2]);
        if (!Number.isInteger(i) || i < 0 || i >= reps.length) {
          fail(res, 404, `representation ${i} of ${reps.length}`);
          return true;
        }
        serveBlob(req, res, reps[i], method === 'HEAD');
        return true;
      }

      // POST /v1/media/ingress — bytes in, root descriptor out.
      if (path === '/v1/media/ingress' && method === 'POST') {
        if (!opts.ingest) {
          fail(res, 501, 'no ingress service installed on this host');
          return true;
        }
        const ctrl = new AbortController();
        const deadline = setTimeout(() => ctrl.abort(), uploadTimeout);
        readBounded(req, { maxBytes: maxUpload, timeoutMs: uploadTimeout })
          .then((bytes) => opts.ingest!(bytes, ctrl.signal))
          .then((descriptor) => {
            const body = JSON.stringify(descriptor);
            res.writeHead(201, head({
              'Content-Type': 'application/json',
              'Content-Length': String(Buffer.byteLength(body)),
            }));
            res.end(body);
          })
          .catch((e: unknown) => {
            const tooLarge = e instanceof TooLarge;
            const tooSlow = e instanceof TooSlow || ctrl.signal.aborted;
            const code = tooLarge ? 413 : tooSlow ? 408 : 400;
            fail(res, code, e instanceof Error ? e.message : 'ingress failed');
            // Now that the status is on the wire, stop the upload. A stalled
            // client will not close on its own — that is the whole problem —
            // so the timeout path has to drop the socket just as the cap does.
            if (tooLarge || tooSlow) req.destroy();
          })
          .finally(() => clearTimeout(deadline));
        return true;
      }

      fail(res, 405, 'unsupported method or path');
      return true;
    } catch (e) {
      fail(res, 500, e instanceof Error ? e.message : 'content route failed');
      return true;
    }
  };
}
