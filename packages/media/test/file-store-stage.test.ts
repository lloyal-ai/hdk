/**
 * Large originals reach the store without passing through memory whole: an
 * upload is staged chunk by chunk, hashed as it arrives, and admitted under its
 * digest only when the caller's digest matches. Reads of part of a blob serve
 * from the file without rehashing it; full reads still verify every byte.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FileAttachmentStore } from '../src/file-store';

const dirs: string[] = [];
function store(): { content: FileAttachmentStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'stage-media-'));
  dirs.push(dir);
  return { content: new FileAttachmentStore(dir), dir };
}
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

const BYTES = new Uint8Array(Array.from({ length: 10_000 }, (_, i) => i % 251));
const digestOf = (bytes: Uint8Array): string => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of stream as unknown as AsyncIterable<Uint8Array>) parts.push(part);
  return new Uint8Array(Buffer.concat(parts));
}

describe('staged uploads', () => {
  it('appends in order and admits under the matching digest', () => {
    const { content } = store();
    const upload = content.stage();
    upload.append(BYTES.subarray(0, 4000));
    upload.append(BYTES.subarray(4000));
    expect(upload.size).toBe(BYTES.length);
    const d = upload.adopt(digestOf(BYTES), 'video/mp4');
    expect(d).toEqual({ mediaType: 'video/mp4', digest: digestOf(BYTES), size: BYTES.length });
    expect(content.get(d.digest)).toEqual(BYTES);
  });

  it('a digest mismatch admits nothing and removes the staging', () => {
    const { content, dir } = store();
    const upload = content.stage();
    upload.append(BYTES);
    expect(() => upload.adopt(digestOf(new Uint8Array([1])), 'video/mp4')).toThrow(/digest/);
    expect(readdirSync(join(dir, 'blobs', 'sha256'))).toEqual([]);
    expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
  });

  it('an inspection that refuses the bytes admits nothing', () => {
    const { content, dir } = store();
    const upload = content.stage();
    upload.append(BYTES);
    expect(() => upload.adopt(digestOf(BYTES), 'video/mp4', () => { throw new Error('not a video container'); }))
      .toThrow(/not a video container/);
    expect(readdirSync(join(dir, 'blobs', 'sha256'))).toEqual([]);
  });

  it('discarding a staged upload leaves nothing behind', () => {
    const { content, dir } = store();
    const upload = content.stage();
    upload.append(BYTES);
    upload.discard();
    expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
    expect(() => upload.append(BYTES)).toThrow(/closed/);
  });
});

describe('ranged reads', () => {
  it('reports a size and serves an exact byte range', async () => {
    const { content } = store();
    const d = content.putBlob(BYTES, 'video/mp4');
    expect(content.size(d.digest)).toBe(BYTES.length);
    expect(await collect(content.readRange(d.digest, { start: 100, end: 1099 })!)).toEqual(BYTES.subarray(100, 1100));
    expect(content.size(`sha256:${'0'.repeat(64)}`)).toBeNull();
    expect(content.readRange(`sha256:${'0'.repeat(64)}`, { start: 0, end: 1 })).toBeNull();
  });

  it('ranged reads do not rehash; full reads still refuse drifted bytes', async () => {
    const { content, dir } = store();
    const d = content.putBlob(BYTES, 'video/mp4');
    const drifted = BYTES.slice(); drifted[5] ^= 0xff;
    writeFileSync(join(dir, 'blobs', 'sha256', d.digest.slice(7)), drifted);
    expect(content.get(d.digest)).toBeNull();
    expect(await collect(content.readRange(d.digest, { start: 0, end: 9 })!)).toEqual(drifted.subarray(0, 10));
    expect(existsSync(join(dir, 'blobs', 'sha256', d.digest.slice(7)))).toBe(true);
  });
});

describe('whole reads', () => {
  // Five of the file stream's 64 KiB pieces: enough to read it a piece at a time.
  const LARGE = new Uint8Array(Array.from({ length: 300_000 }, (_, i) => (i * 7) % 251));

  it('streams a stored blob whole, a piece at a time, verified', async () => {
    const { content } = store();
    const d = content.putBlob(LARGE, 'application/octet-stream');
    const pieces: Uint8Array[] = [];
    for await (const piece of content.readWhole(d.digest)! as unknown as AsyncIterable<Uint8Array>) pieces.push(piece);
    expect(pieces.length).toBeGreaterThan(1);
    expect(new Uint8Array(Buffer.concat(pieces))).toEqual(LARGE);
  });

  it('a blob that no longer matches its digest errors before its last bytes are released', async () => {
    const { content, dir } = store();
    const d = content.putBlob(LARGE, 'application/octet-stream');
    const drifted = LARGE.slice();
    drifted[drifted.length - 1] ^= 0xff;
    writeFileSync(join(dir, 'blobs', 'sha256', d.digest.slice(7)), drifted);
    let released = 0;
    const read = async (): Promise<void> => {
      for await (const piece of content.readWhole(d.digest)! as unknown as AsyncIterable<Uint8Array>) released += piece.byteLength;
    };
    await expect(read()).rejects.toThrow(/no longer matches its digest/);
    expect(released).toBeLessThan(LARGE.length);
  });

  it('answers null for a blob it does not hold', () => {
    const { content } = store();
    expect(content.readWhole(`sha256:${'0'.repeat(64)}`)).toBeNull();
  });
});
