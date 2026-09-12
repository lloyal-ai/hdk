/**
 * The default content store — the one a harness gets when it installs none.
 *
 * Its whole job is the asymmetry: a text-only run must pay nothing and notice
 * nothing, while media must fail LOUDLY and early. Returning null for media
 * would let the caller prefill anyway and produce KV that can never be
 * replayed — the silent outcome every guard in this package exists to prevent.
 */
import { describe, it, expect } from 'vitest';
import { NullAttachmentStore } from '../src/store';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const ABSENT = 'sha256:' + 'c'.repeat(64);

describe('NullAttachmentStore', () => {
  it('is inert for text', () => {
    // "Inert" is about a text-only run never REACHING a write: this is the
    // context default, so `.expect()` must never throw and lookups must answer
    // like any other store asked for content it does not hold.
    const s = new NullAttachmentStore();

    expect(s.get(ABSENT)).toBeNull();
    expect(s.getManifest(ABSENT)).toBeNull();
  });

  it('refuses every write, including an empty one', () => {
    // There is no such thing as a successful write to a store that does not
    // exist. The empty-bytes case used to return null — a second convention
    // for a call no production path makes, and the one place this class
    // answered a write with an absence.
    const s = new NullAttachmentStore();

    expect(() => s.putBlob(JPEG, 'image/jpeg')).toThrow(/No content store installed/);
    expect(() => s.putBlob(new Uint8Array(0), 'application/octet-stream'))
      .toThrow(/No content store installed/);
    expect(() => s.putAttachment({ representations: [] })).toThrow(/No content store/);
  });
});
