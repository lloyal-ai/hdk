/**
 * `asAttachment` — the untrusted JSON boundary.
 *
 * The input arrives as parsed JSON from a client (a browser uploads over the
 * content plane, gets a root back, and sends it in a command), so it is a
 * CLAIM about content, not a `Descriptor` anyone typed. The function must
 * validate the complete shape before applying the brand — and must never
 * throw on junk, because junk is exactly what a boundary receives.
 */
import { describe, it, expect } from 'vitest';
import { asAttachment, MANIFEST_TYPE } from '../src/attachment';

const DIGEST = 'sha256:' + 'a'.repeat(64);
const VALID = { digest: DIGEST, mediaType: MANIFEST_TYPE, size: 9 };

describe('asAttachment', () => {
  it('brands the complete, well-formed shape', () => {
    expect(asAttachment(VALID)).toBe(VALID);
  });

  it('refuses non-objects without throwing', () => {
    for (const junk of [null, undefined, 'sha256:abc', 42, true]) {
      expect(asAttachment(junk)).toBeNull();
    }
  });

  it('refuses a missing or malformed digest', () => {
    expect(asAttachment({ ...VALID, digest: undefined })).toBeNull();
    expect(asAttachment({ ...VALID, digest: 'sha256:short' })).toBeNull();
    expect(asAttachment({ ...VALID, digest: 42 })).toBeNull();
  });

  it('refuses a media type that does not point at a manifest', () => {
    expect(asAttachment({ ...VALID, mediaType: 'image/jpeg' })).toBeNull();
    expect(asAttachment({ ...VALID, mediaType: undefined })).toBeNull();
  });

  it('refuses a missing or insane size', () => {
    expect(asAttachment({ ...VALID, size: undefined })).toBeNull();
    expect(asAttachment({ ...VALID, size: NaN })).toBeNull();
    expect(asAttachment({ ...VALID, size: -1 })).toBeNull();
    expect(asAttachment({ ...VALID, size: 1.5 })).toBeNull();
    expect(asAttachment({ ...VALID, size: '9' })).toBeNull();
  });
});
