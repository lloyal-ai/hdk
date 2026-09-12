/**
 * The commit sequence — the rule every store would otherwise re-implement.
 *
 * `putAttachment`'s body was byte-identical in the filesystem store and the
 * in-memory double: decide the config, write it, compose, write the manifest.
 * Only the last step differs between stores, and only by HOW bytes are stored.
 * A third store would have to reproduce the rest, and the step most easily
 * dropped is the one with no local consequence — writing the canonical empty
 * config blob. A manifest that merely NAMES it looks correct to us and fails
 * every puller, which is why `verify:oci` gives it a check of its own.
 */
import { describe, it, expect } from 'vitest';
import { asAttachment, commitManifest, EMPTY_DESCRIPTOR, MANIFEST_TYPE, representationsOf, sourceOf } from '../src/index';
import type { Descriptor } from '../src/index';
import { createHash } from 'node:crypto';

/** The minimum a store is: bytes in, descriptor out. */
const recorder = () => {
  const written: { mediaType: string; bytes: Uint8Array }[] = [];
  const putBlob = (bytes: Uint8Array, mediaType: string): Descriptor => {
    written.push({ mediaType, bytes });
    return {
      mediaType,
      digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
    };
  };
  return { written, putBlob };
};

const REP: Descriptor = { mediaType: 'image/jpeg', digest: 'sha256:' + 'a'.repeat(64), size: 10 };

describe('commitManifest', () => {
  it('WRITES the canonical empty config, never only names it', () => {
    const { written, putBlob } = recorder();

    const ref = commitManifest(putBlob, { representations: [REP] });

    const config = written.find(w => w.mediaType === EMPTY_DESCRIPTOR.mediaType);
    expect(config, 'the config blob was named but never stored').toBeDefined();
    expect(new TextDecoder().decode(config!.bytes)).toBe('{}');
    expect(ref.mediaType).toBe(MANIFEST_TYPE);
  });

  it('writes the config BEFORE the manifest that references it', () => {
    // Blobs first, manifest second: a crash may leave orphan blobs, never a
    // committed manifest pointing at content that is not there.
    const { written, putBlob } = recorder();

    commitManifest(putBlob, { representations: [REP] });

    expect(written.map(w => w.mediaType))
      .toEqual([EMPTY_DESCRIPTOR.mediaType, MANIFEST_TYPE]);
  });

  it('stores a caller-supplied config and references THAT digest', () => {
    const { written, putBlob } = recorder();
    const bytes = new TextEncoder().encode('{"timeline":[]}');

    const ref = commitManifest(putBlob, {
      representations: [REP],
      config: { bytes, mediaType: 'application/vnd.lloyal.timeline.v1+json' },
    });

    const stored = written.find(w => w.mediaType.includes('timeline'));
    expect(stored, 'a supplied config must be stored like any other blob').toBeDefined();
    const manifest = JSON.parse(new TextDecoder().decode(
      written.find(w => w.mediaType === MANIFEST_TYPE)!.bytes));
    expect(manifest.config.digest).not.toBe(EMPTY_DESCRIPTOR.digest);
    expect(manifest.config.size).toBe(bytes.byteLength);
    expect(ref.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('refuses an attachment with no representation', () => {
    const { putBlob } = recorder();
    expect(() => commitManifest(putBlob, { representations: [] }))
      .toThrow(/no representation/i);
  });

  it('tags layer roles so replay can tell them apart', () => {
    const { written, putBlob } = recorder();
    const source: Descriptor = { mediaType: 'image/png', digest: 'sha256:' + 'b'.repeat(64), size: 99 };

    commitManifest(putBlob, { representations: [REP], source });

    const manifest = JSON.parse(new TextDecoder().decode(
      written.find(w => w.mediaType === MANIFEST_TYPE)!.bytes));
    expect(representationsOf(manifest)).toHaveLength(1);
    expect(sourceOf(manifest)?.digest).toBe(source.digest);
  });
});

describe('asAttachment — the untrusted-wire boundary', () => {
  it('accepts a well-formed manifest descriptor', () => {
    expect(asAttachment({ mediaType: MANIFEST_TYPE, digest: 'sha256:' + 'f'.repeat(64), size: 1 }))
      .not.toBeNull();
  });

  it('refuses a descriptor that points at a BLOB, not a manifest', () => {
    // The design's central rule: an attachment references a manifest. A client
    // sending a representation digest would otherwise have it treated as a
    // root and expanded as one.
    expect(asAttachment({ mediaType: 'image/jpeg', digest: 'sha256:' + 'f'.repeat(64), size: 1 }))
      .toBeNull();
  });

  it('refuses a malformed digest rather than building a path from it', () => {
    for (const digest of ['../../etc/passwd', 'sha512:' + 'a'.repeat(64), 'sha256:xyz', '']) {
      expect(asAttachment({ mediaType: MANIFEST_TYPE, digest, size: 1 }), digest).toBeNull();
    }
  });
});
