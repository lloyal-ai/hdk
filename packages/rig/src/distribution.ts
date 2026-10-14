/**
 * @file Blob upload over the OCI distribution API: how an original too large to
 * hold in memory reaches the store.
 *
 * The content plane's single-payload ingress buffers a whole body, which is
 * right for an image and wrong for a video. A registry already defines the
 * answer, and the store is already an OCI image layout, so the host speaks the
 * distribution spec's blob push: open a session, append chunks in order,
 * resume by asking how far it got, close with the digest of the whole.
 *
 * ```
 * GET    /v2/                                     API version check
 * POST   /v2/<name>/blobs/uploads/                open a session (?digest= uploads in one request)
 * PATCH  /v2/<name>/blobs/uploads/<id>            append the next chunk (Content-Range must start where the last ended)
 * GET    /v2/<name>/blobs/uploads/<id>            how far the session got
 * PUT    /v2/<name>/blobs/uploads/<id>?digest=   close: verify the whole, then admit (an optional last chunk rides the body)
 * DELETE /v2/<name>/blobs/uploads/<id>            cancel
 * HEAD   /v2/<name>/blobs/<digest>                whether a blob is stored
 * GET    /v2/<name>/blobs/<digest>                the blob, whole (verified) or by Range (206)
 * ```
 *
 * A blob is readable by its digest, as from any registry: the spec's push
 * flow verifies the returned location by reading it back, and a digest is
 * identity, never authorization. A whole read goes through the store's
 * verifying `get`; a ranged read streams from the file, which the store's
 * contract states. There is no manifest push: a caller never authors a
 * manifest, and a video's is composed by the host from references
 * (`video:compose`).
 *
 * Every repository name addresses the one project store. A pushed blob is
 * inert until a composition references it, and the composition inspects it.
 *
 * Transport-agnostic, like `resolveContent`: the HTTP host and the desktop
 * scheme both read a chunk under their own bounds and hand this table the bytes.
 *
 * @category Runtime
 */
import { DIGEST_PATTERN } from '@lloyal-labs/media';
import type { AttachmentStore } from '@lloyal-labs/media';
import type { BlobStaging, StagedBlob } from '@lloyal-labs/media/node';
import { decodeURISegment, parseByteRange } from './content-routes';
import type { ContentReply } from './content-routes';

/** One distribution request, reduced to what the table reads. */
export interface DistributionRequest {
  method: string;
  /** Path only. */
  path: string;
  query: URLSearchParams;
  /** `Content-Range` verbatim, when the client sent one. */
  contentRange?: string;
  /** `Range` verbatim, when the client sent one. */
  range?: string;
  /** The chunk, already read under the transport's bounds. */
  body?: Uint8Array;
}

/** The largest chunk one request may carry. A client slices larger files. */
export const MAX_UPLOAD_CHUNK_BYTES = 64 * 1024 * 1024;

/** Whether a path belongs to the distribution API. */
export const isDistributionPath = (path: string): boolean => path === '/v2/' || path === '/v2' || path.startsWith('/v2/');

/** OCI repository names: path components of lowercase alphanumerics and separators. */
const NAME = '[a-z0-9]+(?:(?:\\.|_|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:\\.|_|__|-+)[a-z0-9]+)*)*';
const UPLOADS = new RegExp(`^/v2/(${NAME})/blobs/uploads/?$`);
const UPLOAD = new RegExp(`^/v2/(${NAME})/blobs/uploads/([0-9a-f]{32})$`);
const BLOB = new RegExp(`^/v2/(${NAME})/blobs/([^/]+)$`);

const encoder = new TextEncoder();

/** The spec's error shape, `{ errors: [{ code, message }] }`. */
const ociError = (status: number, code: string, message: string): ContentReply => {
  const body = encoder.encode(JSON.stringify({ errors: [{ code, message }] }));
  return { status, headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.byteLength) }, body };
};

const empty = (status: number, headers: Record<string, string> = {}): ContentReply =>
  ({ status, headers: { 'Content-Length': '0', ...headers } });

/** `Range` for a session: the bytes received, inclusive. Empty is `0-0`, as registries answer it. */
const received = (size: number): string => `0-${Math.max(0, size - 1)}`;

/** `Content-Range: <start>-<end>` → both ends, or null when malformed. */
const chunkRange = (header: string): { start: number; end: number } | null => {
  const m = /^(?:bytes )?(\d+)-(\d+)$/.exec(header.trim());
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null;
};

/**
 * The upload sessions of one host: staged blobs by id, over one store.
 *
 * In memory: a session does not survive a host restart, and a client that
 * resumes against a restarted host is told the upload is unknown and starts
 * again. An abandoned session's staging stays in the store's `.tmp`, where the
 * store's retention policy reclaims it.
 *
 * @category Runtime
 */
export class BlobUploads {
  private readonly _sessions = new Map<string, StagedBlob>();

  constructor(readonly staging: BlobStaging, readonly store: AttachmentStore) {}

  /** Answer one distribution request, or null when the path is not ours. Never throws. */
  resolve(req: DistributionRequest): ContentReply | null {
    if (!isDistributionPath(req.path)) return null;
    try {
      return this._route(req);
    } catch (e) {
      const disk = typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOSPC';
      return disk
        ? ociError(507, 'UNKNOWN', 'the store is out of disk space')
        : ociError(500, 'UNKNOWN', e instanceof Error ? e.message : 'upload failed');
    }
  }

  private _route(req: DistributionRequest): ContentReply {
    const { method, path } = req;
    if ((path === '/v2/' || path === '/v2') && (method === 'GET' || method === 'HEAD')) {
      return empty(200, { 'Docker-Distribution-API-Version': 'registry/2.0' });
    }

    const uploads = UPLOADS.exec(path);
    if (uploads && method === 'POST') return this._open(uploads[1], req);

    const upload = UPLOAD.exec(path);
    if (upload) {
      const [, name, id] = upload;
      const session = this._sessions.get(id);
      if (!session) return ociError(404, 'BLOB_UPLOAD_UNKNOWN', 'no such upload session');
      const location = `/v2/${name}/blobs/uploads/${id}`;
      switch (method) {
        case 'GET':
          return empty(204, { Location: location, Range: received(session.size), 'Docker-Upload-UUID': id });
        case 'PATCH': {
          const refused = this._append(session, req);
          return refused ?? empty(202, { Location: location, Range: received(session.size), 'Docker-Upload-UUID': id });
        }
        case 'PUT': {
          const refused = req.body && req.body.byteLength > 0 ? this._append(session, req) : null;
          if (refused) return refused;
          return this._close(name, id, session, req.query.get('digest'));
        }
        case 'DELETE':
          session.discard();
          this._sessions.delete(id);
          return empty(204);
        default:
          return ociError(405, 'UNSUPPORTED', 'unsupported method for an upload session');
      }
    }

    const blob = BLOB.exec(path);
    if (blob && blob[2] !== 'uploads') {
      const digest = decodeURISegment(blob[2]);
      if (digest === null || !DIGEST_PATTERN.test(digest)) return ociError(400, 'DIGEST_INVALID', 'only sha256 digests are stored');
      const size = this.store.size(digest);
      if (size === null) return ociError(404, 'BLOB_UNKNOWN', 'blob not in store');
      const headers = { 'Docker-Content-Digest': digest, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' };
      if (method === 'HEAD') return { status: 200, headers: { ...headers, 'Content-Length': String(size) } };
      if (method !== 'GET') return ociError(405, 'UNSUPPORTED', 'blobs are pushed through an upload session, never deleted');
      if (req.range) {
        const range = parseByteRange(req.range, size);
        const stream = range ? this.store.readRange(digest, range) : null;
        if (!range || !stream) return { ...ociError(416, 'BLOB_UNKNOWN', 'range not satisfiable'), headers: { 'Content-Range': `bytes */${size}` } };
        return {
          status: 206,
          headers: { ...headers, 'Content-Length': String(range.end - range.start + 1), 'Content-Range': `bytes ${range.start}-${range.end}/${size}` },
          stream,
        };
      }
      const bytes = this.store.get(digest);
      if (!bytes) return ociError(404, 'BLOB_UNKNOWN', 'blob missing or no longer matches its digest');
      return { status: 200, headers: { ...headers, 'Content-Length': String(bytes.byteLength) }, body: bytes };
    }
    return ociError(405, 'UNSUPPORTED', 'unsupported distribution request');
  }

  /** POST: a new session, or the whole blob in one request when the digest rides along. */
  private _open(name: string, req: DistributionRequest): ContentReply {
    const session = this.staging.stage();
    const digest = req.query.get('digest');
    if (digest) {
      // Never registered, so nothing could cancel it later: a write that fails (a full disk) lets it go here.
      try {
        if (req.body) session.append(req.body);
      } catch (e) {
        session.discard();
        throw e;
      }
      return this._close(name, session.id, session, digest);
    }
    this._sessions.set(session.id, session);
    const location = `/v2/${name}/blobs/uploads/${session.id}`;
    return empty(202, { Location: location, Range: '0-0', 'Docker-Upload-UUID': session.id });
  }

  /**
   * Append in order: a chunk that does not start where the last ended is
   * refused, not reordered, and so is one whose range does not describe its
   * body, byte for byte.
   */
  private _append(session: StagedBlob, req: DistributionRequest): ContentReply | null {
    if (req.contentRange !== undefined) {
      const range = chunkRange(req.contentRange);
      const length = req.body?.length ?? 0;
      if (range === null || range.end < range.start || range.end - range.start + 1 !== length) {
        return ociError(400, 'BLOB_UPLOAD_INVALID', `Content-Range must name the ${length} bytes sent`);
      }
      const { start } = range;
      if (start !== session.size) {
        const refusal = ociError(416, 'BLOB_UPLOAD_INVALID', `chunk must start at ${session.size}`);
        return { ...refusal, headers: { ...refusal.headers, Range: received(session.size) } };
      }
    }
    if (req.body) session.append(req.body);
    return null;
  }

  /** PUT ?digest=: verify the whole and admit, or refuse and admit nothing. */
  private _close(name: string, id: string, session: StagedBlob, digest: string | null): ContentReply {
    this._sessions.delete(id);
    if (!digest || !DIGEST_PATTERN.test(digest)) {
      session.discard();
      return ociError(400, 'DIGEST_INVALID', 'a sha256 digest of the whole blob is required');
    }
    try {
      const d = session.adopt(digest, 'application/octet-stream');
      return empty(201, { Location: `/v2/${name}/blobs/${d.digest}`, 'Docker-Content-Digest': d.digest });
    } catch (e) {
      if (e instanceof Error && /digest mismatch/.test(e.message)) return ociError(400, 'DIGEST_INVALID', e.message);
      throw e;
    }
  }
}
