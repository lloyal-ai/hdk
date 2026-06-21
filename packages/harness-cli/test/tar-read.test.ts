/**
 * Tests for the dep-free tarball reader used by publish (post-pack assert) +
 * install (attention-surface display). Builds a gzipped ustar tarball with
 * node:zlib + a manual header writer, matching the worker's tarball-inspect test.
 */
import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { readTarEntry } from '../src/tar-read';

const TAR_BLOCK = 512;

function writeField(buf: Uint8Array, off: number, val: string, len: number): void {
  const bytes = new TextEncoder().encode(val);
  for (let i = 0; i < len; i++) buf[off + i] = i < bytes.length ? bytes[i] : 0;
}

function header(name: string, size: number): Uint8Array {
  const h = new Uint8Array(TAR_BLOCK);
  writeField(h, 0, name, 100);
  writeField(h, 100, '0000644', 8);
  writeField(h, 124, size.toString(8).padStart(11, '0'), 12);
  writeField(h, 136, '00000000000', 12);
  for (let i = 148; i < 156; i++) h[i] = 0x20;
  h[156] = 0x30;
  writeField(h, 257, 'ustar', 6);
  writeField(h, 263, '00', 2);
  let cksum = 0;
  for (let i = 0; i < TAR_BLOCK; i++) cksum += h[i];
  writeField(h, 148, cksum.toString(8).padStart(6, '0'), 6);
  h[154] = 0x00;
  h[155] = 0x20;
  return h;
}

function buildTarball(entries: Array<{ name: string; content: string }>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const body = new TextEncoder().encode(e.content);
    parts.push(header(e.name, body.byteLength));
    const padded = new Uint8Array(Math.ceil(body.byteLength / TAR_BLOCK) * TAR_BLOCK);
    padded.set(body);
    parts.push(padded);
  }
  parts.push(new Uint8Array(TAR_BLOCK * 2));
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const tar = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    tar.set(p, off);
    off += p.byteLength;
  }
  return new Uint8Array(gzipSync(tar));
}

describe('readTarEntry', () => {
  it('reads a present entry by full path', async () => {
    const tgz = buildTarball([
      { name: 'package/package.json', content: '{"name":"x"}' },
      { name: 'package/attention-surface.json', content: '{"skill":"hi"}' },
    ]);
    expect(await readTarEntry(tgz, 'package/attention-surface.json')).toBe('{"skill":"hi"}');
  });

  it('returns null for an absent entry', async () => {
    const tgz = buildTarball([{ name: 'package/package.json', content: '{}' }]);
    expect(await readTarEntry(tgz, 'package/attention-surface.json')).toBeNull();
  });

  it('returns null on non-gzip / corrupt input (never throws)', async () => {
    expect(await readTarEntry(new Uint8Array([1, 2, 3, 4]), 'package/x')).toBeNull();
  });

  it('caps a zip bomb instead of OOMing', async () => {
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(65 * 1024 * 1024, 0)));
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    // The 64 MiB maxOutputLength makes gunzip throw → readTarEntry returns null.
    expect(await readTarEntry(bomb, 'package/x')).toBeNull();
  });
});
