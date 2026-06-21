/**
 * Dependency-free reader for a single entry out of a gzipped npm-pack tarball.
 *
 * Ported verbatim from the publish-worker's `tarball-inspect.ts` (the format is
 * frozen ustar; npm-pack never emits GNU long-names or sparse files). Used by:
 *   - `publish`  — assert `package/attention-surface.json` actually landed in the
 *                  produced .tgz (a missing `files` whitelist entry fails LOUD on
 *                  the publisher's machine, not silently in the channel).
 *   - `install`  — read the (Ed25519-verified) attention surface for display.
 *
 * Decompression uses the Node built-in `zlib.gunzipSync` (with a bounded
 * `maxOutputLength`) — no npm dependency, preserving the CLI's zero-dep promise.
 */

import { gunzipSync } from 'node:zlib';

const TAR_BLOCK_SIZE = 512;
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

/**
 * Decompress a gzip stream with a hard output cap (a tiny zip bomb can expand
 * ~1000×). `maxOutputLength` makes zlib throw before allocating past the cap.
 */
function gunzip(bytes: Uint8Array): Uint8Array {
  const out = gunzipSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

function readString(tar: Uint8Array, offset: number, maxLen: number): string {
  let end = offset;
  const limit = Math.min(offset + maxLen, tar.byteLength);
  while (end < limit && tar[end] !== 0) end++;
  return new TextDecoder().decode(tar.subarray(offset, end));
}

function isZeroBlock(tar: Uint8Array, offset: number): boolean {
  for (let i = offset; i < offset + TAR_BLOCK_SIZE && i < tar.byteLength; i++) {
    if (tar[i] !== 0) return false;
  }
  return true;
}

function findEntry(tar: Uint8Array, wantedName: string): Uint8Array | null {
  let offset = 0;
  while (offset + TAR_BLOCK_SIZE <= tar.byteLength) {
    if (isZeroBlock(tar, offset)) return null;
    const name = readString(tar, offset, 100);
    const prefix = readString(tar, offset + 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeStr = readString(tar, offset + 124, 12);
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    if (!Number.isFinite(size) || size < 0) return null;
    if (offset + TAR_BLOCK_SIZE + size > tar.byteLength) return null;
    const typeflag = tar[offset + 156];
    const isRegularFile = typeflag === 0 || typeflag === 0x30; /* '0' */
    if (isRegularFile && fullName === wantedName) {
      return tar.slice(offset + TAR_BLOCK_SIZE, offset + TAR_BLOCK_SIZE + size);
    }
    const contentBlocks = Math.ceil(size / TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE + contentBlocks * TAR_BLOCK_SIZE;
  }
  return null;
}

/**
 * Read one file's UTF-8 contents from a gzipped tarball. Returns null when the
 * entry is ABSENT — but ALSO when the tarball is unreadable/corrupt or its
 * decompressed size exceeds {@link MAX_DECOMPRESSED_BYTES} (gunzip throws), or
 * when a header is malformed. Callers that need to distinguish "entry missing"
 * from "tarball unreadable" should probe with {@link isGzipReadable}.
 */
export async function readTarEntry(
  gzippedTarball: Uint8Array,
  entryName: string,
): Promise<string | null> {
  let tar: Uint8Array;
  try {
    tar = gunzip(gzippedTarball);
  } catch {
    return null;
  }
  const bytes = findEntry(tar, entryName);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

/**
 * True if the gzip stream decompresses within the size cap. Lets callers tell
 * an ABSENT entry apart from an UNREADABLE/over-cap tarball — both of which
 * otherwise surface as {@link readTarEntry} → null — so they can print an
 * honest diagnostic instead of mislabeling a corrupt/oversized package as
 * "entry not present".
 */
export function isGzipReadable(gzippedTarball: Uint8Array): boolean {
  try {
    gunzip(gzippedTarball);
    return true;
  } catch {
    return false;
  }
}
