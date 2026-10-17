/**
 * A chunk that fails partway through being written leaves nothing of itself
 * behind: the staged file is rolled back to what the hash has seen, so a retry
 * cannot adopt bytes that differ from the digest it is admitted under. Lives
 * apart from the store suite because it replaces `appendFileSync` with a disk
 * that fills mid-write.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The next appends to fail: each writes half of its bytes, then reports a full disk. */
const failing = { appends: 0, truncate: true };
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return {
    ...real,
    appendFileSync: (file: fs.PathOrFileDescriptor, data: Uint8Array) => {
      if (failing.appends > 0) {
        failing.appends--;
        real.appendFileSync(file, data.subarray(0, Math.floor(data.length / 2)));
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      real.appendFileSync(file, data);
    },
    truncateSync: (file: fs.PathLike, len?: number) => {
      if (!failing.truncate) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      real.truncateSync(file, len);
    },
  };
});

const { FileAttachmentStore } = await import('../src/file-store');
const digestOf = (bytes: Uint8Array): string => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); failing.appends = 0; failing.truncate = true; });
const store = () => { const d = mkdtempSync(join(tmpdir(), 'partial-append-')); dirs.push(d); return new FileAttachmentStore(d); };

describe('a staged upload when the disk fills mid-chunk', () => {
  it('rolls the chunk back, so a retry adopts exactly the bytes its digest names', () => {
    const content = store();
    const first = new Uint8Array(100).fill(1);
    const second = new Uint8Array(100).fill(2);
    const whole = new Uint8Array([...first, ...second]);
    const upload = content.stage();
    upload.append(first);
    failing.appends = 1;
    expect(() => upload.append(second)).toThrow(/ENOSPC/);
    expect(upload.size).toBe(100);
    upload.append(second);
    const admitted = upload.adopt(digestOf(whole), 'application/octet-stream');
    expect(admitted.size).toBe(200);
    expect(content.get(digestOf(whole))).toEqual(whole);
  });

  it('closes the upload when the rollback itself fails: nothing it holds can be adopted', () => {
    const content = store();
    const upload = content.stage();
    upload.append(new Uint8Array(10).fill(1));
    failing.appends = 1;
    failing.truncate = false;
    expect(() => upload.append(new Uint8Array(10).fill(2))).toThrow(/ENOSPC/);
    expect(() => upload.append(new Uint8Array(10).fill(2))).toThrow(/closed/);
    expect(() => upload.adopt(digestOf(new Uint8Array(20)), 'application/octet-stream')).toThrow(/closed/);
  });
});

