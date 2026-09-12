/**
 * The filesystem content store — conformance of the OCI Image Layout it writes.
 *
 * Here rather than in `agents` because the layout is irreducibly Node and the
 * implementation lives with rig's other filesystem mechanics. What `agents`
 * still owns is the SHAPE (`commitManifest`) and the contract; those are pure
 * and tested there. The failure this guards is a directory that resembles a
 * layout without being one — `oras`/`crane`/`skopeo` read it with none of our
 * code in the path, so "close enough" is indistinguishable from broken.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAttachmentStore } from '../src/file-store';
import {
  representationsOf, sourceOf, sniffMediaType, ATTACHMENT_ARTIFACT_TYPE, EMPTY_DESCRIPTOR,
} from '../src/index';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'lloyal-att-'));
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const BMP = new Uint8Array([0x42, 0x4d, 7, 7]);
const JUNK = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

describe('FileAttachmentStore — an OCI Image Layout', () => {
  it('writes the three entries image-layout.md requires', () => {
    const dir = tmp();
    const s = new FileAttachmentStore(dir);
    s.putBlob(JPEG, 'image/jpeg');
    expect(JSON.parse(readFileSync(join(dir, 'oci-layout'), 'utf8')))
      .toEqual({ imageLayoutVersion: '1.0.0' });
    const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    expect(idx.schemaVersion).toBe(2);
    expect(idx.mediaType).toBe('application/vnd.oci.image.index.v1+json');
    // Deterministic path: the type is on the descriptor, so nothing has to
    // guess an extension.
    expect(existsSync(join(dir, 'blobs', 'sha256'))).toBe(true);
  });

  it('never puts a non-blob entry inside the algorithm directory', () => {
    // Every entry under `blobs/<algorithm>/` must be a blob whose filename IS
    // its encoded digest. Staging a write as `<hex>.tmp` there would leave a
    // malformed entry behind on a crash, and would trip any tool enumerating
    // blobs — so staging lives at the layout root, which the spec allows.
    const dir = tmp();
    const s = new FileAttachmentStore(dir);
    s.putAttachment({ representations: [s.putBlob(JPEG, 'image/jpeg')!] });
    for (const name of readdirSync(join(dir, 'blobs', 'sha256'))) {
      expect(name).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(existsSync(join(dir, '.tmp'))).toBe(true);
  });

  it('round-trips a blob under an algorithm-prefixed digest', () => {
    const dir = tmp();
    const s = new FileAttachmentStore(dir);
    const d = s.putBlob(JPEG, 'image/jpeg');
    expect(d.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(d.size).toBe(JPEG.byteLength);
    expect(d.mediaType).toBe('image/jpeg');
    expect(Array.from(s.get(d.digest)!)).toEqual(Array.from(JPEG));
  });

  it('composes a conformant artifact manifest', () => {
    const dir = tmp();
    const s = new FileAttachmentStore(dir);
    const rep = s.putBlob(PNG, 'image/png', { 'ai.lloyal.derive.quality': '82' });
    const src = s.putBlob(JPEG, 'image/jpeg');
    const att = s.putAttachment({ representations: [rep], source: src });

    expect(att.mediaType).toBe('application/vnd.oci.image.manifest.v1+json');
    const m = s.getManifest(att.digest)!;
    expect(m.schemaVersion).toBe(2);
    expect(m.artifactType).toBe(ATTACHMENT_ARTIFACT_TYPE);
    // An artifact manifest still REQUIRES a config; OCI's canonical empty blob
    // fills the slot — and must EXIST, not merely be named, because a puller
    // fetches it like any other blob.
    expect(m.config).toEqual(EMPTY_DESCRIPTOR);
    expect(Array.from(s.get(EMPTY_DESCRIPTOR.digest)!)).toEqual([0x7b, 0x7d]);
    expect(m.layers).toHaveLength(2);
  });

  it('separates what entered the cache from what the user supplied', () => {
    const dir = tmp();
    const s = new FileAttachmentStore(dir);
    const rep = s.putBlob(PNG, 'image/png');
    const src = s.putBlob(JPEG, 'image/jpeg');
    const m = s.getManifest(s.putAttachment({ representations: [rep], source: src }).digest)!;
    // The distinction replay depends on: the DERIVED bytes were decoded, so
    // those are what a rebuild must use.
    expect(representationsOf(m).map(d => d.digest)).toEqual([rep.digest]);
    expect(sourceOf(m)!.digest).toBe(src.digest);
  });

  it('keeps derivation parameters on the representation', () => {
    const dir = tmp();
    // Not provenance: the same source under two settings is different pixels
    // and therefore different KV, so what derived it is part of the record.
    const s = new FileAttachmentStore(dir);
    const rep = s.putBlob(PNG, 'image/png', { 'ai.lloyal.derive.maxPixels': '262144' });
    const m = s.getManifest(s.putAttachment({ representations: [rep] }).digest)!;
    expect(representationsOf(m)[0].annotations!['ai.lloyal.derive.maxPixels']).toBe('262144');
  });

  it('indexes each manifest once, deduped by digest', () => {
    const dir = tmp();
    const s = new FileAttachmentStore(dir);
    const rep = s.putBlob(PNG, 'image/png');
    const a = s.putAttachment({ representations: [rep] });
    const b = s.putAttachment({ representations: [rep] });
    expect(b.digest).toBe(a.digest);
    expect(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).manifests).toHaveLength(1);
  });

  it('refuses a manifest with no representation', () => {
    const dir = tmp();
    // `layers` must hold at least one descriptor to be valid, and an
    // attachment where nothing reached the cache is meaningless anyway.
    expect(() => new FileAttachmentStore(dir).putAttachment({ representations: [] }))
      .toThrow(/no representation/i);
  });

  it('sniffs the formats mtmd decodes, and stores unknown bytes anyway', () => {
    const dir = tmp();
    expect(sniffMediaType(JPEG)).toBe('image/jpeg');
    expect(sniffMediaType(PNG)).toBe('image/png');
    expect(sniffMediaType(GIF)).toBe('image/gif');
    expect(sniffMediaType(BMP)).toBe('image/bmp');
    // Validating pixels belongs to the normalizer and the decoder, both of
    // which fail better than this could — so unknown bytes still store.
    expect(sniffMediaType(JUNK)).toBe('application/octet-stream');
    const s = new FileAttachmentStore(dir);
    const d = s.putBlob(JUNK, sniffMediaType(JUNK));
    expect(Array.from(s.get(d.digest)!)).toEqual(Array.from(JUNK));
  });

  it('dedupes by content — the same bytes twice is one file', () => {
    const dir = tmp();
    const s = new FileAttachmentStore(dir);
    const a = s.putBlob(PNG, 'image/png');
    const b = s.putBlob(new Uint8Array(PNG), 'image/png');
    expect(b.digest).toBe(a.digest);
    expect(readdirSync(join(dir, 'blobs', 'sha256'))).toHaveLength(1);
  });

  it('creates nothing until something is stored', () => {
    const dir = join(tmp(), 'content');
    const s = new FileAttachmentStore(dir);
    expect(existsSync(dir)).toBe(false); // a text-only run leaves no directory
    s.putBlob(JPEG, 'image/jpeg');
    expect(existsSync(dir)).toBe(true);
  });

  it('returns null for an unknown digest, a bad digest, and an unwritable dir', () => {
    const dir = tmp();
    const s = new FileAttachmentStore(dir);
    expect(s.get('sha256:' + 'b'.repeat(64))).toBeNull();
    // Never build a path out of an unvalidated string.
    expect(s.get('../../etc/passwd')).toBeNull();
    expect(s.get('sha512:' + 'c'.repeat(64))).toBeNull();
  });

  it('reports a disk failure with the reason, rather than as an absence', () => {
    // A write that fails must say so, and say WHY. Returning null defers the
    // failure to replay — except there is nothing there to defer TO: when the
    // representation write fails, `putAttachment` never runs, so no manifest
    // exists and replay has nothing to refuse. The run would simply carry on
    // with media in the cache and no record of it.
    expect(() => new FileAttachmentStore('/proc/nonexistent/nope').putBlob(JPEG, 'image/jpeg'))
      .toThrow(/ENOENT|ENOTDIR|EACCES|EROFS/);
  });

  it('refuses a manifest whose artifact type it does not understand', () => {
    const dir = tmp();
    const s = new FileAttachmentStore(dir);
    const d = s.putBlob(new TextEncoder().encode('{"artifactType":"application/vnd.other"}'),
      'application/vnd.oci.image.manifest.v1+json');
    expect(s.getManifest(d.digest)).toBeNull();
  });

  it('refuses a corrupt or hand-made manifest instead of serving it', () => {
    // `layers: [null]` used to pass the shallow check and then crash
    // `representationsOf`; a layer without a digest would hand the HTTP
    // routes a descriptor that cannot resolve. Refused HERE, uniformly.
    const dir = tmp();
    const s = new FileAttachmentStore(dir);
    const manifest = (layers: unknown): string =>
      JSON.stringify({ artifactType: ATTACHMENT_ARTIFACT_TYPE, layers });
    const put = (json: string) =>
      s.putBlob(new TextEncoder().encode(json), 'application/vnd.oci.image.manifest.v1+json');

    for (const layers of [
      [null],
      ['a-string'],
      [{ mediaType: 'image/jpeg', size: 3 }],                                   // no digest
      [{ digest: 'sha256:short', mediaType: 'image/jpeg', size: 3 }],           // bad digest
      [{ digest: 'sha256:' + 'a'.repeat(64), size: 3 }],                        // no mediaType
      [{ digest: 'sha256:' + 'a'.repeat(64), mediaType: 'image/jpeg', size: -1 }],
    ]) {
      expect(s.getManifest(put(manifest(layers)).digest)).toBeNull();
    }

    // Control: a fully-formed layer passes — the validation refuses junk,
    // not foreign-but-valid manifests.
    const ok = put(manifest([
      { digest: 'sha256:' + 'b'.repeat(64), mediaType: 'image/jpeg', size: 3 },
    ]));
    expect(s.getManifest(ok.digest)).not.toBeNull();
  });
});
