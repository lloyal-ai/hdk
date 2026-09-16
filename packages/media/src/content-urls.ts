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
export async function ingestMedia(origin: string, bytes: Uint8Array): Promise<Descriptor> {
  const res = await fetch(ingressUrl(origin), {
    method: 'POST',
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

/** The citation grammar the documents ability emits and the model copies:
 *  `attachment://<digest prefix>/page/<n>`. The prefix is the asset's own
 *  identity, resolved by the view against digests it already holds. */
export function parseAttachmentHref(href: string): { prefix: string; page: number } | null {
  const m = /^attachment:\/\/([0-9a-f]{6,64})\/page\/(\d+)$/i.exec(href);
  return m ? { prefix: m[1].toLowerCase(), page: Number(m[2]) } : null;
}

/** Exactly one digest may answer to a prefix; zero or several is no answer. */
export function resolvePrefix(prefix: string, digests: readonly string[]): string | null {
  const hits = digests.filter((d) => d.replace(/^sha256:/, '').startsWith(prefix));
  return hits.length === 1 ? hits[0] : null;
}
