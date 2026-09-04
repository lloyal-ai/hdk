import { ATTACHMENT_ARTIFACT_TYPE, commitManifest } from '@lloyal-labs/media';
import type { Attachment, AttachmentManifest, Descriptor } from '@lloyal-labs/media';
import type { AttachmentStore } from '@lloyal-labs/media';
import { createHash } from 'node:crypto';

/**
 * An AttachmentStore that keeps blobs in a Map.
 *
 * FOR TESTS ONLY, and deliberately NOT a second content store: manifests are
 * committed through the same {@link commitManifest} the filesystem store uses, so this
 * cannot drift into testing a shape production never writes. What it replaces
 * is persistence — the OCI Image Layout on disk is rig's, and its conformance
 * is tested there. Tests that only need a working store (replay, ingress,
 * the barrier) use this and stay off the filesystem.
 */
export class MemoryAttachmentStore implements AttachmentStore {
  readonly blobs = new Map<string, Uint8Array>();

  putBlob(bytes: Uint8Array, mediaType: string, annotations?: Record<string, string>): Descriptor {
    const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    this.blobs.set(digest, bytes);
    return { mediaType, digest, size: bytes.byteLength, ...(annotations ? { annotations } : {}) };
  }

  putAttachment(parts: {
    representations: readonly Descriptor[];
    source?: Descriptor;
    config?: { bytes: Uint8Array; mediaType: string };
    annotations?: Record<string, string>;
  }): Attachment {
    // Through the SAME commit sequence production uses, which is the point of
    // this double: it replaces persistence, not the format. A double that
    // reimplemented the sequence could drift into testing a shape nothing
    // writes.
    return commitManifest((bytes, mediaType) => this.putBlob(bytes, mediaType), parts);
  }

  get(digest: string, opts?: { verify?: boolean }): Uint8Array | null {
    const bytes = this.blobs.get(digest) ?? null;
    if (!bytes || !opts?.verify) return bytes;
    return 'sha256:' + createHash('sha256').update(bytes).digest('hex') === digest ? bytes : null;
  }

  getManifest(digest: string): AttachmentManifest | null {
    const bytes = this.get(digest);
    if (!bytes) return null;
    try {
      // Every blob is a candidate — most are image bytes, not JSON. Mirrors
      // the filesystem store: asking about a digest that is not a manifest is
      // a normal question with a normal answer.
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as AttachmentManifest;
      return parsed?.artifactType === ATTACHMENT_ARTIFACT_TYPE && Array.isArray(parsed.layers)
        ? parsed
        : null;
    } catch {
      return null;
    }
  }
}
