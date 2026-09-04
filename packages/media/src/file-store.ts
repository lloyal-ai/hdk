/**
 * @file The OCI Image Layout, on the filesystem.
 *
 * FORMAT, not policy: how bytes are addressed and laid out. Where a project
 * puts them is `createProjectMediaStore` in rig. Needs `node:fs`, so it is
 * reachable only through `@lloyal-labs/media/node` — the package root stays
 * browser-safe.
 */
import { ATTACHMENT_ARTIFACT_TYPE, commitManifest, DIGEST_PATTERN } from './attachment';
import type { Attachment, AttachmentManifest, Descriptor } from './attachment';
import type { AttachmentStore } from './store';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LAYOUT_VERSION = '1.0.0';
const INDEX_TYPE = 'application/vnd.oci.image.index.v1+json';

/**
 * An OCI Image Layout on the filesystem.
 *
 * Writes the three things `image-layout.md` requires — `oci-layout`,
 * `index.json`, and `blobs/<algorithm>/<encoded>` — so the directory is a
 * valid layout rather than a private format that resembles one. Paths are
 * derivable from the digest alone: the type travels on the descriptor, so
 * there is no extension to guess.
 *
 * Created on the first write, so a text-only run leaves nothing behind.
 *
 * **Known limitation:** `index.json` is a mutable shared root, updated
 * read-modify-write. The writes are synchronous, so concurrent Sessions inside
 * ONE host process serialize safely; two processes writing the same layout can
 * still lose an index entry. Blobs are unaffected (content-addressed, written
 * temp-then-rename), so the loss is discoverability, not data. Reachability GC
 * is deliberately absent — nothing here deletes.
 *
 * @category Media
 */
export class FileAttachmentStore implements AttachmentStore {
  private _dir: string;
  private _ready = false;

  /** @param dir - The layout root. */
  constructor(dir: string) {
    this._dir = dir;
  }

  /** `sha256:<hex>` → `<dir>/blobs/sha256/<hex>`. Null for an algorithm this
   *  build does not implement, rather than building a path out of an
   *  unvalidated string. */
  private _pathFor(digest: string): string | null {
    if (!DIGEST_PATTERN.test(digest)) return null;
    const hex = digest.slice('sha256:'.length);
    return join(this._dir, 'blobs', 'sha256', hex);
  }

  /** Create the layout skeleton once: the blob dir, the `oci-layout` marker,
   *  and an empty index if none exists. */
  private _ensureLayout(): void {
    if (this._ready) return;
    mkdirSync(join(this._dir, 'blobs', 'sha256'), { recursive: true });
    // Staging lives OUTSIDE the algorithm directory. Every entry under
    // `blobs/<algorithm>/` must be a blob whose filename is its own encoded
    // digest, so a `<hex>.tmp` there is a malformed entry that a crash would
    // make permanent — and tooling enumerating blobs would trip over it.
    mkdirSync(join(this._dir, '.tmp'), { recursive: true });
    const marker = join(this._dir, 'oci-layout');
    if (!existsSync(marker)) {
      writeFileSync(marker, JSON.stringify({ imageLayoutVersion: LAYOUT_VERSION }));
    }
    const index = join(this._dir, 'index.json');
    if (!existsSync(index)) {
      writeFileSync(index, JSON.stringify({ schemaVersion: 2, mediaType: INDEX_TYPE, manifests: [] }));
    }
    this._ready = true;
  }

  putBlob(
    bytes: Uint8Array,
    mediaType: string,
    annotations?: Record<string, string>,
  ): Descriptor {
    const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    // Lazy, and deliberately so: a text-only run must leave the layout
    // untouched. Its errors now PROPAGATE, which is what tells "this store was
    // never usable" (a read-only volume) apart from "this write failed" (a full
    // disk) — the classification the old catch-all erased, without paying for
    // it by creating directories a run may never need.
    this._ensureLayout();
    const file = this._pathFor(digest)!;
    // Content-addressed, so a file already at this path IS these bytes — and
    // if it has drifted, `get` refuses it; this write does not repair it.
    // Temp-then-rename so a reader never sees a half-written blob under a
    // digest that promises the whole of it.
    if (!existsSync(file)) {
      // Matches `writeJsonAtomic` (rig/src/config-node.ts), which is the
      // repo's reference for this: a RANDOM suffix so concurrent writers never
      // collide on a guessable name (pid alone is deterministic and recycled),
      // `wx` so a planted file or symlink at that path fails the write instead
      // of being followed, and cleanup so a crash leaves no stray. The rename
      // is same-filesystem and therefore atomic.
      const tmp = join(
        this._dir, '.tmp', `${digest.slice(7)}.${randomBytes(4).toString('hex')}`,
      );
      try {
        writeFileSync(tmp, bytes, { flag: 'wx' });
        renameSync(tmp, file);
      } catch (e) {
        try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
        throw e;
      }
    }
    return { mediaType, digest, size: bytes.byteLength, ...(annotations ? { annotations } : {}) };
  }

  putAttachment(parts: {
    representations: readonly Descriptor[];
    source?: Descriptor;
    config?: { bytes: Uint8Array; mediaType: string };
    annotations?: Record<string, string>;
  }): Attachment {
    // The SEQUENCE is format, so it lives with the format: config blob, then
    // manifest, blobs before the record that references them. What is left
    // here is the only thing a filesystem store does differently — how bytes
    // land, and the index entry, which no other store has.
    const ref = commitManifest((bytes, mediaType) => this.putBlob(bytes, mediaType), parts);
    this._index(ref);
    return ref;
  }

  /** Append a manifest descriptor to `index.json`, deduped by digest. */
  private _index(ref: Descriptor): void {
    try {
      const file = join(this._dir, 'index.json');
      const idx = JSON.parse(readFileSync(file, 'utf8')) as { manifests: Descriptor[] };
      if (idx.manifests.some(m => m.digest === ref.digest)) return;
      idx.manifests.push(ref);
      const tmp = join(this._dir, '.tmp', `index.${randomBytes(4).toString('hex')}`);
      try {
        writeFileSync(tmp, JSON.stringify(idx, null, 2), { flag: 'wx' });
        renameSync(tmp, file);
      } catch (e) {
        try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
        throw e;
      }
    } catch {
      // The blob landed; only its index entry did not. Our own resolution is
      // by digest, so this costs discoverability by other OCI tooling, not
      // replay.
    }
  }

  get(digest: string): Uint8Array | null {
    try {
      const file = this._pathFor(digest);
      if (!file) return null;
      const bytes = new Uint8Array(readFileSync(file));
      // The name is a promise about the bytes, kept on every read (see the
      // contract). Sub-millisecond for a normalized representation.
      const actual = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
      return actual === digest ? bytes : null;
    } catch {
      return null;
    }
  }

  getManifest(digest: string): AttachmentManifest | null {
    const bytes = this.get(digest);
    if (!bytes) return null;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as AttachmentManifest;
      // Check the artifact type rather than guessing: the version in it exists
      // to let a future build refuse a shape it does not understand. And
      // validate every layer as a full descriptor — a corrupt or hand-made
      // manifest (`layers: [null]`, a missing digest) must be refused HERE,
      // not crash `representationsOf` or hand malformed descriptors to the
      // HTTP routes. Role semantics stay as documented: a layer without a
      // role annotation is a representation.
      const layerOk = (l: unknown): boolean => {
        if (typeof l !== 'object' || l === null) return false;
        const { digest: d, mediaType, size } = l as Record<string, unknown>;
        return typeof d === 'string' && DIGEST_PATTERN.test(d) &&
          typeof mediaType === 'string' &&
          typeof size === 'number' && Number.isSafeInteger(size) && size >= 0;
      };
      return parsed?.artifactType === ATTACHMENT_ARTIFACT_TYPE &&
        Array.isArray(parsed.layers) && parsed.layers.every(layerOk)
        ? parsed
        : null;
    } catch {
      return null;
    }
  }
}
