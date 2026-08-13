/**
 * The drift gate for the channel's signature encoding.
 *
 * **Why this file exists.** Until it did, `canonicalJson` and
 * `catalogSignedBytes` in `src/verify.ts` had *zero* coverage. They were
 * private, reachable only through `fetchAndVerifyCatalog`, which
 * `verify.test.ts` deliberately skips (its header says so) and
 * `install.test.ts` mocks away wholesale. Editing those nine lines left all
 * 15 tests green while breaking every `install` and every `new` in the field.
 *
 * **Why a frozen fixture rather than a round-trip.** Every other
 * signing/verification test in this repo and in the publish-worker signs with
 * one copy of `canonicalJson` and verifies with another copy of the same
 * function. That catches a one-sided edit and nothing else — a change applied
 * to signer and verifier together sails straight through. The only oracle that
 * cannot be fooled is bytes the platform actually signed, which no test can
 * regenerate. Hence `fixtures/prod-catalog-2026-07-29.json`: the live
 * `apps.lloyal.ai/v1/catalog.json` as served, verified here against the trust
 * root committed in `verify.ts`.
 *
 * **Why the synthetic vectors are not redundant with the fixture.** Measured,
 * not assumed: swapping the key sort to `localeCompare` leaves the frozen
 * catalog verifying perfectly, because every key in it is lowercase-initial
 * camelCase and the two orderings agree on that set. Only the mixed-case
 * vector below catches it. Conversely, `\u`-escaping non-ASCII passes several
 * vectors but breaks the real signature. Each layer covers the other's blind
 * spot; deleting either one silently halves this file.
 *
 * The fixture is FROZEN. It is not the current catalog and must never be
 * refreshed to match one — a fixture that tracks production proves nothing.
 * If the platform key rotates, add the new key to `CHANNEL_TRUST_ROOTS` and
 * add a second fixture; do not replace this one.
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
  CHANNEL_TRUST_ROOTS,
  type SignedCatalog,
} from '../src/verify';

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
// Ported from `publish-worker/test/crypto.test.ts`, which until now held the
// only frozen-byte assertions on this encoding anywhere — and sat on the
// SIGNER side, where a verifier regression is invisible.

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
    // would) fails to verify the real catalog. This is why `canonicalJson`
    // documents itself as deliberately NOT RFC 8785.
    expect(canonicalJson({ d: 'a—b' })).toBe('{"d":"a—b"}');
    // {"d":"—"} = 8 ASCII chars + a 3-byte em dash = 11. The count IS the
    // assertion: `—` escaping would make it 14.
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

  it('ships the trust root the catalog was signed with', () => {
    const key = CHANNEL_TRUST_ROOTS.get(KEY_ID);
    expect(key).toBeDefined();
    expect(key!.length).toBe(32);
    expect(sha256(key!)).toBe(KEY_SHA256);
  });

  it('verifies under the committed trust root', async () => {
    const bytes = catalogSignedBytes(
      catalog.signedAt,
      catalog.entries,
      catalog.publisherKeyId,
    );
    const key = CHANNEL_TRUST_ROOTS.get(KEY_ID)!;
    await expect(verifyBundle(bytes, catalog.signature, key)).resolves.toBe(
      true,
    );
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
    // `signature` is deliberately NOT part of its own payload, and the field
    // order in the object literal is irrelevant (keys are sorted). Including
    // an extra field must break verification.
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
});

// ── The hazard this encoding carries ─────────────────────────────

describe('undefined-valued keys (characterisation)', () => {
  it('cannot reach the verifier — JSON.parse never produces undefined', () => {
    // The verifier's only input is a parsed HTTP body, so the hazard below is
    // unreachable from here. Recorded so the constraint is explicit rather
    // than accidental.
    const parsed = JSON.parse('{"a":1}') as Record<string, unknown>;
    expect(Object.values(parsed).every((v) => v !== undefined)).toBe(true);
  });

  it('produces invalid JSON on the SIGNER side, which is where the guard belongs', () => {
    // `Object.entries` KEEPS a key whose value is `undefined`; `JSON.stringify`
    // DROPS it. The worker signs `canonicalJson(catalog)` but writes
    // `JSON.stringify(catalog)` to R2 — so one explicitly-undefined property
    // anywhere in `entries` yields a catalog that no client can ever verify.
    //
    // Nothing here can prevent that; a verifier can only fail. Today it is
    // held off by convention alone — the `if (m.iconUrl)` omit-rather-than-
    // undefine idiom in publish-worker/src/schema.ts. This test pins the
    // behaviour so the convention's importance is visible from this side too.
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1,"b":undefined}');
    expect(JSON.stringify({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => JSON.parse(canonicalJson({ a: 1, b: undefined }))).toThrow();
  });
});
