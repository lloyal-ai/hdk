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
import type { Hash } from 'node:crypto';
import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const LAYOUT_VERSION = '1.0.0';

/**
 * An upload in progress: bytes appended in order, hashed as they arrive, and
 * addressed only when adopted under the digest its sender claims.
 *
 * @category Media
 */
export interface StagedBlob {
  readonly id: string;
  /** Bytes received so far — where the next chunk must begin. */
  readonly size: number;
  /** Append the next chunk. Throws on a full disk, carrying the reason. */
  append(bytes: Uint8Array): void;
  /** Admit the staged bytes under `digest`: verified, inspected, then renamed
   *  into place. On any refusal nothing is admitted and the staging is gone. */
  adopt(digest: string, mediaType: string, inspect?: (head: Uint8Array, size: number) => void): Descriptor;
  /** Cancel: remove the staging. */
  discard(): void;
}

/**
 * Where uploads too large to hold in memory are staged: the filesystem store,
 * never the browser-safe contract, because staging is a file.
 *
 * @category Media
 */
export interface BlobStaging {
  stage(): StagedBlob;
}

/** How many leading bytes `adopt` hands an inspection: enough for any container signature. */
const INSPECT_BYTES = 64;

/** The first bytes of a file, without reading the rest of it. */
function readHead(file: string): Uint8Array {
  const head = new Uint8Array(INSPECT_BYTES);
  const fd = openSync(file, 'r');
  try {
    return head.subarray(0, readSync(fd, head, 0, INSPECT_BYTES, 0));
  } finally {
    closeSync(fd);
  }
}
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
export class FileAttachmentStore implements AttachmentStore, BlobStaging {
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
    // Content-addressed: the name is a promise about the bytes. Every put
    // keeps it by writing, never by trusting what is already at the path — a
    // drifted or planted file there would otherwise leave this content
    // unreplayable for good, while `get` kept refusing it. Rewriting identical
    // bytes is idempotent, and concurrent puts of the same content converge.
    // Temp-then-rename so a reader never sees a half-written blob under a
    // digest that promises the whole of it. The staging name matches
    // `writeJsonAtomic` (rig/src/config-node.ts): a RANDOM suffix so
    // concurrent writers never collide on a guessable name, `wx` so a planted
    // file or symlink at that path fails the write instead of being followed,
    // and cleanup so a crash leaves no stray. The rename is same-filesystem and
    // therefore atomic, over an existing file included.
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

  size(digest: string): number | null {
    try {
      const file = this._pathFor(digest);
      return file ? statSync(file).size : null;
    } catch {
      return null;
    }
  }

  readRange(digest: string, range: { start: number; end: number }): ReadableStream<Uint8Array> | null {
    const size = this.size(digest);
    if (size === null || range.start < 0 || range.end < range.start || range.end >= size) return null;
    const stream = createReadStream(this._pathFor(digest)!, { start: range.start, end: range.end });
    return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  }

  readWhole(digest: string): ReadableStream<Uint8Array> | null {
    const file = this._pathFor(digest);
    if (!file || this.size(digest) === null) return null;
    const pieces = createReadStream(file)[Symbol.asyncIterator]();
    const hash = createHash('sha256');
    // One piece is always held back, so the whole is verified before a reader has all of it.
    let held: Uint8Array | null = null;
    return new ReadableStream<Uint8Array>({
      // Every pull releases a piece, closes or errors: a pull that did none would wait for another that never comes.
      async pull(controller) {
        for (;;) {
          const next = await pieces.next();
          if (next.done) break;
          const piece = new Uint8Array(next.value as Buffer);
          hash.update(piece);
          const release = held;
          held = piece;
          if (release) return controller.enqueue(release);
        }
        if ('sha256:' + hash.digest('hex') !== digest) {
          return controller.error(new Error(`blob ${digest} no longer matches its digest`));
        }
        if (held) controller.enqueue(held);
        controller.close();
      },
      async cancel() {
        await pieces.return?.();
      },
    });
  }

  /**
   * Begin a staged upload. The staging file sits in `.tmp`, outside the blob
   * directory, so a crash leaves no malformed blob; the same rename that
   * `putBlob` uses admits it. A staging that is never adopted or discarded
   * stays in `.tmp`: the store deletes nothing on its own.
   */
  stage(): StagedBlob {
    this._ensureLayout();
    const id = randomBytes(16).toString('hex');
    const tmp = join(this._dir, '.tmp', `upload.${id}`);
    writeFileSync(tmp, new Uint8Array(0), { flag: 'wx' });
    const hash: Hash = createHash('sha256');
    let size = 0;
    let open = true;
    const close = (): void => {
      open = false;
      try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    };
    const pathFor = (d: string): string | null => this._pathFor(d);
    return {
      id,
      get size() { return size; },
      append(bytes) {
        if (!open) throw new Error('this upload is closed');
        try {
          appendFileSync(tmp, bytes);
        } catch (e) {
          // Part of the chunk may be on disk while the hash has seen none of it. Rolled back to what the
          // hash has seen, a retry stays byte for byte with the digest; if even that fails, the upload closes.
          try { truncateSync(tmp, size); } catch { close(); }
          throw e;
        }
        hash.update(bytes);
        size += bytes.byteLength;
      },
      adopt(digest, mediaType, inspect) {
        if (!open) throw new Error('this upload is closed');
        try {
          const actual = 'sha256:' + hash.digest('hex');
          if (actual !== digest) throw new Error(`upload digest mismatch: the bytes hash to ${actual}`);
          inspect?.(readHead(tmp), size);
          renameSync(tmp, pathFor(digest)!);
          open = false;
          return { mediaType, digest, size };
        } catch (e) {
          close();
          throw e;
        }
      },
      discard: close,
    };
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
