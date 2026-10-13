/**
 * @file Every door of the content plane, derived from ONE transport fact: the
 * origin a bridge reports. The route grammar is the host's
 * (`createContentRoutes` / `resolveContent` in `@lloyal-labs/rig/node`); this
 * is its client half, shared by every target, so a route added there is a
 * function added here and nowhere else. The origin is `""` on a same-origin
 * dev proxy, an `http(s)://host:port` on a served host, a custom scheme's
 * authority (`attachment://store`) on a desktop.
 *
 * Browser-safe: `fetch` and nothing else.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Descriptor } from './attachment';

const enc = encodeURIComponent;

/** Where bytes go up: POST the file, get its ROOT descriptor back. */
export const ingressUrl = (origin: string): string => `${origin}/v1/media/ingress`;
/** The manifest itself — what says whether a root is an image or a document. */
export const manifestUrl = (origin: string, digest: string): string => `${origin}/v1/media/${enc(digest)}`;
/** The typed config blob behind a manifest: a document's sidecar. */
export const configUrl = (origin: string, digest: string): string => `${origin}/v1/media/${enc(digest)}/config`;
/** The original as supplied, when the ingest retained it — a document's PDF.
 *  Resolved through the manifest by role, so it is the source the manifest
 *  names and nothing else. */
export const sourceUrl = (origin: string, digest: string): string => `${origin}/v1/media/${enc(digest)}/source`;
/** Resolves THROUGH the manifest, so a retained source layer can never be
 *  served in place of the copy the projector actually encoded. */
export const representationUrl = (origin: string, digest: string, index = 0): string =>
  `${origin}/v1/media/${enc(digest)}/representations/${index}`;

/**
 * Admit a file and get back its ROOT descriptor.
 *
 * The bytes go over HTTP; only the descriptor goes over the socket — a frame
 * on the event wire is kept for replay, so a payload there would sit in the
 * history forever. The host decides what "admitted" means (the bytes pick the
 * door: an image is normalized, a PDF is read into a document) and hands back
 * a reference; the client never learns the digest of anything it uploaded,
 * because the root is the manifest's hash, not the file's.
 */
export async function ingestMedia(origin: string, bytes: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<Descriptor> {
  const res = await fetch(ingressUrl(origin), {
    method: 'POST',
    signal: options.signal,
    // No `Content-Type`: the bytes answer that question, and the route stopped
    // reading the header because a client cannot be the authority on content
    // it did not produce.
    body: bytes as BodyInit,
  });
  if (!res.ok) {
    // The route answers 413 too large, 408 too slow, 400 not admitted, 501 no
    // ingress installed. Its own message is better than anything invented here.
    throw new Error((await res.text().catch(() => '')) || `upload failed (${res.status})`);
  }
  return (await res.json()) as Descriptor;
}

/** The repository every original is pushed under. One project store answers
 *  any name; this one says what the blobs are. */
const SOURCES_REPOSITORY = 'lloyal/sources';

/** Where an original's upload session is opened. */
export const blobUploadsUrl = (origin: string): string => `${origin}/v2/${SOURCES_REPOSITORY}/blobs/uploads/`;

/** How much of a file one request carries. Under the host's per-chunk bound. */
const PUSH_CHUNK_BYTES = 8 * 1024 * 1024;
/** Attempts per chunk before the push gives up. */
const PUSH_ATTEMPTS = 4;

/**
 * Push a file the single-payload ingress cannot take whole — a video's original
 * — as an OCI blob, chunk by chunk, and get back its descriptor.
 *
 * Each chunk is a slice of the file, so the whole never sits in memory; the
 * digest is computed as the slices go. A chunk that fails is retried after
 * asking the host how far it got, so a dropped connection resumes rather than
 * restarting. The blob is inert until a composition references it: this
 * returns a reference to hand to one, typed as the bytes will be inspected
 * there, never trusted from the file's name.
 */
export async function pushBlob(
  origin: string,
  file: Blob,
  options: { signal?: AbortSignal; onProgress?: (sent: number, total: number) => void; chunkBytes?: number } = {},
): Promise<Descriptor> {
  const { signal, onProgress, chunkBytes = PUSH_CHUNK_BYTES } = options;
  const opened = await fetch(blobUploadsUrl(origin), { method: 'POST', signal });
  if (opened.status !== 202) throw new Error(await failure(opened, 'could not open an upload'));
  const location = locationOf(origin, opened);
  const hash = sha256.create();
  for (let offset = 0; offset < file.size;) {
    const end = Math.min(file.size, offset + chunkBytes);
    const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    await sendChunk(location, chunk, offset, signal);
    hash.update(chunk);
    offset = end;
    onProgress?.(offset, file.size);
  }
  const digest = `sha256:${bytesToHex(hash.digest())}`;
  const closed = await fetch(`${location}${location.includes('?') ? '&' : '?'}digest=${encodeURIComponent(digest)}`, { method: 'PUT', signal });
  if (closed.status !== 201) throw new Error(await failure(closed, 'the upload was not admitted'));
  return { mediaType: file.type || 'application/octet-stream', digest, size: file.size };
}

/** Send one chunk, resuming from what the host reports it holds when a send fails. */
async function sendChunk(location: string, chunk: Uint8Array, offset: number, signal?: AbortSignal): Promise<void> {
  const end = offset + chunk.byteLength - 1;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(location, {
        method: 'PATCH', signal, body: chunk as BodyInit,
        headers: { 'Content-Range': `${offset}-${end}`, 'Content-Type': 'application/octet-stream' },
      });
      if (res.status === 202) return;
      if (res.status !== 416) throw new Error(await failure(res, 'a chunk was refused'));
    } catch (e) {
      if (signal?.aborted || attempt >= PUSH_ATTEMPTS) throw e;
    }
    // The host's own account of how far it got decides: this chunk landed, or send it again.
    const held = await fetch(location, { method: 'GET', signal });
    const through = Number(/^0-(\d+)$/.exec(held.headers.get('Range') ?? '')?.[1] ?? -1);
    if (through === end) return;
    // `0-0` is how a registry reports an empty session as well as a one-byte one.
    const holdsNothingNew = through === offset - 1 || (offset === 0 && through === 0);
    if (!holdsNothingNew || attempt >= PUSH_ATTEMPTS) throw new Error(`the upload cannot resume at byte ${offset}`);
  }
}

const locationOf = (origin: string, res: Response): string => {
  const location = res.headers.get('Location');
  if (!location) throw new Error('the host opened an upload without saying where');
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(location) ? location : `${origin}${location}`;
};

const failure = async (res: Response, what: string): Promise<string> =>
  `${what} (${res.status}): ${await res.text().catch(() => '')}`;

/** The citation grammar the documents ability emits and the model copies:
 *  `attachment://<digest prefix>/page/<n>`. The prefix is the asset's own
 *  identity, resolved by the view against digests it already holds. */
export function parseAttachmentHref(href: string): { prefix: string; page: number } | null {
  const m = /^attachment:\/\/([0-9a-f]{6,64})\/page\/(\d+)$/i.exec(href);
  return m ? { prefix: m[1].toLowerCase(), page: Number(m[2]) } : null;
}

/** A moment in a video, in the same grammar: `attachment://<digest prefix>/t/<time>`, where the time is
 *  written as the video marks it to the model (`1m5.00s`) or in milliseconds (`65000`). */
export function parseAttachmentMoment(href: string): { prefix: string; tMs: number } | null {
  const m = /^attachment:\/\/([0-9a-f]{6,64})\/t\/(?:(\d+)m(\d+(?:\.\d+)?)s|(\d+))$/i.exec(href);
  if (!m) return null;
  const tMs = m[4] !== undefined ? Number(m[4]) : Math.round((Number(m[2]) * 60 + Number(m[3])) * 1000);
  return { prefix: m[1].toLowerCase(), tMs };
}

/** Exactly one digest may answer to a prefix; zero or several is no answer. */
export function resolvePrefix(prefix: string, digests: readonly string[]): string | null {
  const hits = digests.filter((d) => d.replace(/^sha256:/, '').startsWith(prefix));
  return hits.length === 1 ? hits[0] : null;
}
