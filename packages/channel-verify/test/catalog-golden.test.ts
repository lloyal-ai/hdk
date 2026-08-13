/**
 * The drift gate for the channel's signature encoding — the canonical copy.
 *
 * **Why a frozen fixture rather than a round-trip.** Every signing/verification
 * test that existed before this one signs with one copy of `canonicalJson` and
 * verifies with another copy of the same function. That catches a one-sided
 * edit and nothing else: a change applied to signer and verifier together
 * passes happily, and that is precisely the change that makes every published
 * app uninstallable. The only oracle that cannot be fooled is bytes the
 * platform actually signed, which no test can regenerate.
 *
 * Hence `fixtures/prod-catalog-2026-07-29.json`: the live
 * `apps.lloyal.ai/v1/catalog.json` as served, verified here against the trust
 * root vendored in `src/index.ts`.
 *
 * **Why the synthetic vectors are not redundant with it.** Measured, not
 * assumed: swapping the key sort to `localeCompare` leaves the frozen catalog
 * verifying perfectly, because every key in it is lowercase-initial camelCase
 * and the two orderings agree on that set. Only the mixed-case vector catches
 * it. Conversely, `\u`-escaping non-ASCII passes several vectors and breaks the
 * real signature. Each layer covers the other's blind spot; deleting either one
 * silently halves this file.
 *
 * The fixture is FROZEN. It is not the current catalog and must never be
 * refreshed to match one — a fixture that tracks production proves nothing. If
 * the platform key rotates, add the new key to `CHANNEL_TRUST_ROOTS` and add a
 * second fixture; do not replace this one.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  catalogSignedBytes,
  verifyBundle,
  verifyCatalogSignature,
  isWellFormedCatalog,
  sha512Integrity,
  base64ToBytes,
  bytesToBase64,
  CHANNEL_TRUST_ROOTS,
  CHANNEL_CATALOG_URL,
  type SignedCatalog,
} from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(here, 'fixtures', 'prod-catalog-2026-07-29.json'), 'utf8'),
) as SignedCatalog;

/** Frozen facts about the fixture. Every one of these is a signature input. */
const CANONICAL_BYTE_LENGTH = 4076;
const CANONICAL_SHA256 =
  '291c32d79a180ee2d9e7ba91f60178220e6a13e73aaf67855a13677e26687aa8';
const KEY_ID = 'lloyal-platform-2026-q2';
const KEY_SHA256 =
  '9e0df3d25b8968a8b2ae9b86cb17a6922368c7cff9674a84b4a2527dd6457ec1';

const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

// ── Golden vectors ───────────────────────────────────────────────
//
// Ported from `publish-worker/test/crypto.test.ts`, which until this package
// existed held the only frozen-byte assertions on this encoding anywhere — and
// sat on the SIGNER side, where a verifier regression is invisible.

describe('canonicalJson — golden vectors', () => {
  it('sorts object keys', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('recurses — nested keys sorted, nested arrays left alone', () => {
    expect(canonicalJson({ z: { b: 1, a: 2 }, a: [{ c: 1 }, { a: 2 }] })).toBe(
      '{"a":[{"c":1},{"a":2}],"z":{"a":2,"b":1}}',
    );
  });

  it('round-trips primitives through JSON.stringify', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(true)).toBe('true');
  });

  it('emits empty containers compactly', () => {
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({ a: {}, b: [] })).toBe('{"a":{},"b":[]}');
  });

  it('sorts by UTF-16 code unit, so uppercase precedes lowercase', () => {
    // Not a locale collation. `localeCompare` would order these differently
    // and would silently produce a payload the signer never signed.
    expect(canonicalJson({ a: 1, B: 2, A: 3 })).toBe('{"A":3,"B":2,"a":1}');
  });

  it('leaves non-ASCII raw rather than \\u-escaping it', () => {
    // Load-bearing: the fixture's descriptions contain U+2014 EM DASH, so a
    // canonicaliser that ASCII-escapes (as a strict RFC 8785 implementation
    // would) fails to verify the real catalog.
    expect(canonicalJson({ d: 'a—b' })).toBe('{"d":"a—b"}');
    // {"d":"—"} = 8 ASCII chars + a 3-byte em dash = 11. The count IS the
    // assertion: escaping would make it 14.
    expect(new TextEncoder().encode(canonicalJson({ d: '—' })).length).toBe(11);
  });
});

// ── The real oracle ──────────────────────────────────────────────

describe('frozen production catalog', () => {
  it('is the fixture we think it is', () => {
    expect(catalog.publisherKeyId).toBe(KEY_ID);
    expect(catalog.signedAt).toBe('2026-07-29T08:11:49.013Z');
    expect(catalog.entries).toHaveLength(4);
  });

  it('canonicalises to exactly the bytes that were signed', () => {
    const bytes = catalogSignedBytes(
      catalog.signedAt,
      catalog.entries,
      catalog.publisherKeyId,
    );
    expect(bytes.length).toBe(CANONICAL_BYTE_LENGTH);
    expect(sha256(bytes)).toBe(CANONICAL_SHA256);
  });

  it('vendors the trust root the catalog was signed with', () => {
    const key = CHANNEL_TRUST_ROOTS.get(KEY_ID);
    expect(key).toBeDefined();
    expect(key!.length).toBe(32);
    expect(sha256(key!)).toBe(KEY_SHA256);
  });

  it('verifies under the vendored trust root', async () => {
    const key = CHANNEL_TRUST_ROOTS.get(KEY_ID)!;
    await expect(verifyCatalogSignature(catalog, key)).resolves.toBe(true);
  });

  it('fails on one character of encoding drift', async () => {
    // Proves the assertion above is load-bearing and not vacuous: a single
    // space after a separator — the most plausible "harmless" reformatting —
    // is enough to break it.
    const drifted = new TextEncoder().encode(
      canonicalJson({
        signedAt: catalog.signedAt,
        entries: catalog.entries,
        publisherKeyId: catalog.publisherKeyId,
      }).replace(',', ', '),
    );
    const key = CHANNEL_TRUST_ROOTS.get(KEY_ID)!;
    await expect(verifyBundle(drifted, catalog.signature, key)).resolves.toBe(
      false,
    );
  });

  it('fails when the signed field set changes', async () => {
    // `signature` is deliberately NOT part of its own payload. Including it
    // must break verification.
    const withExtra = new TextEncoder().encode(
      canonicalJson({
        signedAt: catalog.signedAt,
        entries: catalog.entries,
        publisherKeyId: catalog.publisherKeyId,
        signature: catalog.signature,
      }),
    );
    const key = CHANNEL_TRUST_ROOTS.get(KEY_ID)!;
    await expect(verifyBundle(withExtra, catalog.signature, key)).resolves.toBe(
      false,
    );
  });

  it('fails when a single entry is mutated', async () => {
    const tampered: SignedCatalog = {
      ...catalog,
      entries: catalog.entries.map((e, i) =>
        i === 0 ? { ...e, name: `${e.name}-evil` } : e,
      ),
    };
    const key = CHANNEL_TRUST_ROOTS.get(KEY_ID)!;
    await expect(verifyCatalogSignature(tampered, key)).resolves.toBe(false);
  });

  it('fails under any key but the right one', async () => {
    const wrong = new Uint8Array(CHANNEL_TRUST_ROOTS.get(KEY_ID)!);
    wrong[0] ^= 0xff;
    await expect(verifyCatalogSignature(catalog, wrong)).resolves.toBe(false);
  });
});

// ── Shape checking ───────────────────────────────────────────────

describe('isWellFormedCatalog', () => {
  it('accepts the real catalog', () => {
    expect(isWellFormedCatalog(catalog)).toBe(true);
  });

  it('rejects null and non-objects without throwing', () => {
    expect(isWellFormedCatalog(null)).toBe(false);
    expect(isWellFormedCatalog(undefined)).toBe(false);
    expect(isWellFormedCatalog('a catalog, honest')).toBe(false);
    expect(isWellFormedCatalog(42)).toBe(false);
  });

  it('rejects a document missing any signed field', () => {
    for (const field of [
      'signedAt',
      'entries',
      'publisherKeyId',
      'signature',
    ] as const) {
      const partial = { ...catalog } as Record<string, unknown>;
      delete partial[field];
      expect(isWellFormedCatalog(partial)).toBe(false);
    }
  });

  it('rejects entries that is not an array', () => {
    expect(isWellFormedCatalog({ ...catalog, entries: {} })).toBe(false);
  });

  it('is a shape check, never a trust check', () => {
    // A well-formed document with a garbage signature must still pass the
    // shape gate — conflating the two would let a caller treat "parses" as
    // "verified".
    expect(isWellFormedCatalog({ ...catalog, signature: 'not-base64!!' })).toBe(
      true,
    );
  });
});

// ── Primitives ───────────────────────────────────────────────────

describe('verifyBundle — rejection paths', () => {
  it('returns false rather than throwing on malformed base64', async () => {
    const key = CHANNEL_TRUST_ROOTS.get(KEY_ID)!;
    await expect(verifyBundle(new Uint8Array([1]), '!!!!', key)).resolves.toBe(
      false,
    );
  });

  it('returns false for a wrong-length key or signature', async () => {
    const key = CHANNEL_TRUST_ROOTS.get(KEY_ID)!;
    await expect(
      verifyBundle(new Uint8Array([1]), catalog.signature, new Uint8Array(31)),
    ).resolves.toBe(false);
    await expect(
      verifyBundle(new Uint8Array([1]), bytesToBase64(new Uint8Array(63)), key),
    ).resolves.toBe(false);
  });
});

describe('encoding helpers', () => {
  it('round-trips arbitrary bytes through base64', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 254]);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
  });

  it('uses the standard alphabet, not base64url', () => {
    // 0xfb 0xff encodes as `+/8=` in standard base64 and `-_8` in base64url.
    // The catalog signature is standard, so this is a compatibility assertion.
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff]))).toBe('+/8=');
  });

  it('computes npm-compatible sha512 integrity', async () => {
    const bytes = new TextEncoder().encode('hello');
    const expected = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    await expect(sha512Integrity(bytes)).resolves.toBe(expected);
  });
});

describe('vendored constants', () => {
  it('points at the production channel', () => {
    expect(CHANNEL_CATALOG_URL).toBe('https://apps.lloyal.ai/v1/catalog.json');
  });

  it('freezes the trust roots against mutation', () => {
    expect(Object.isFrozen(CHANNEL_TRUST_ROOTS)).toBe(true);
  });
});

// ── The hazard this encoding carries ─────────────────────────────

describe('undefined-valued keys (characterisation)', () => {
  it('cannot reach a verifier — JSON.parse never produces undefined', () => {
    const parsed = JSON.parse('{"a":1}') as Record<string, unknown>;
    expect(Object.values(parsed).every((v) => v !== undefined)).toBe(true);
  });

  it('produces invalid JSON on the SIGNER side, which is where the guard belongs', () => {
    // `Object.entries` KEEPS a key whose value is `undefined`; `JSON.stringify`
    // DROPS it. A signer that signs canonicalJson(x) but publishes
    // JSON.stringify(x) therefore yields, for one explicitly-undefined
    // property, a document no client can ever verify.
    //
    // Nothing here can prevent that; a verifier can only fail. This pins the
    // behaviour so the omit-rather-than-undefine discipline on the signing
    // side is visibly load-bearing rather than incidental.
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1,"b":undefined}');
    expect(JSON.stringify({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => JSON.parse(canonicalJson({ a: 1, b: undefined }))).toThrow();
  });

  it('is unaffected by an ABSENT optional key, which is the safe idiom', () => {
    // The correct signer discipline, asserted so the contrast is explicit.
    const omitted: Record<string, unknown> = { a: 1 };
    expect(canonicalJson(omitted)).toBe('{"a":1}');
    expect(canonicalJson(JSON.parse(JSON.stringify(omitted)))).toBe(
      canonicalJson(omitted),
    );
  });
});
