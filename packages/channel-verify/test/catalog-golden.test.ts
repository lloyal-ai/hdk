/**
 * The drift gate for the channel's signature encoding — the canonical copy.
 *
 * **Why a frozen fixture rather than a round-trip.** Every signing/verification
 * test that existed before this one signs with one copy of `canonicalJson` and
 * verifies with another copy of the same function. That catches a one-sided
 * edit and nothing else: a change applied to signer and verifier together
 * passes happily, and that is precisely the change that makes every published
 * ability uninstallable. The only oracle that cannot be fooled is bytes the
 * platform actually signed, which no test can regenerate.
 *
 * Hence `fixtures/prod-catalog-2026-08-16.json`: the live
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
 * the platform key rotates, add the new key to `TRUST_ROOTS` in `src/index.ts`
 * and add a second fixture; do not replace this one.
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
  readFileSync(join(here, 'fixtures', 'prod-catalog-2026-08-16.json'), 'utf8'),
) as SignedCatalog;

/** Frozen facts about the fixture. Every one of these is a signature input. */
const CANONICAL_BYTE_LENGTH = 4948;
const CANONICAL_SHA256 =
  '8b69b8a53824777d6eafecf2c023982e0e2008f3800ec1306ad456d7da35e7e0';
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
    // canonicaliser that ASCII-escapes fails to verify the real catalog.
    //
    // Note this is NOT a divergence from RFC 8785, as an earlier version of
    // this comment claimed. RFC 8785 §3.2.2.2 serialises strings as ECMAScript
    // JSON.stringify does, which emits non-ASCII raw — so a conforming
    // implementation agrees with us here. The failure mode guarded against is
    // a hand-rolled canonicaliser that escapes for "safety".
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
    expect(catalog.signedAt).toBe('2026-08-16T05:01:11.399Z');
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


/**
 * A minimal catalog that is well-formed under the CURRENT shape rule.
 *
 * The frozen fixture deliberately is NOT — it predates the
 * `appProtocolVersion` → `abilityProtocolVersion` rename. Shape-predicate tests
 * need a valid document, which is a different job from the fixture's: the
 * fixture is the SIGNATURE oracle, bytes no test can regenerate. Conflating the
 * two is what made these tests fail for a reason unrelated to what they assert.
 */
const shapeValidCatalog = {
  signedAt: '2026-08-16T00:00:00.000Z',
  publisherKeyId: 'lloyal-platform-2026-q2',
  signature: 'AA==',
  entries: [
    {
      name: 'lloyal/example',
      versions: [
        {
          version: '1.0.0',
          manifestUrl: 'https://apps.lloyal.ai/v1/abilities/bundles/x.manifest.json',
          tarballUrl: 'https://apps.lloyal.ai/v1/abilities/bundles/x.tgz',
          abilityProtocolVersion: '3.0',
          sizeBytes: 1,
          importName: '@lloyal-labs/example-ability',
        },
      ],
    },
  ],
};

// ── Shape checking ───────────────────────────────────────────────

describe('isWellFormedCatalog', () => {
  // Valid again, and deliberately so. The shape check guarantees the fields
  // callers dereference; the protocol version is not one of them. Requiring it
  // made a CUMULATIVE catalog invalid the moment one historical version predated
  // the rename — which is exactly what happened in production.
  it('accepts the real catalog, old protocol field and all', () => {
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
    expect(isWellFormedCatalog({ ...shapeValidCatalog, signature: 'not-base64!!' })).toBe(
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

describe('the base64 globals are a stated requirement, not an assumption', () => {
  // `atob`/`btoa` are HTML globals, not WebCrypto, so a runtime can provide
  // `crypto.subtle` and lack them. Save/restore rather than mock so the check
  // exercises the real code path; `finally` keeps the rest of the suite safe.
  function withoutBase64<T>(fn: () => T): T {
    const real = { atob: globalThis.atob, btoa: globalThis.btoa };
    // @ts-expect-error deliberately removing a global to simulate the runtime
    delete globalThis.atob;
    // @ts-expect-error deliberately removing a global to simulate the runtime
    delete globalThis.btoa;
    try {
      return fn();
    } finally {
      Object.assign(globalThis, real);
    }
  }

  it('fails by name, not as a bare ReferenceError', () => {
    withoutBase64(() => {
      expect(() => base64ToBytes('AAAA')).toThrow(/no atob\/btoa/);
      expect(() => bytesToBase64(new Uint8Array(2))).toThrow(/no atob\/btoa/);
    });
  });

  it('does not report a broken runtime as a bad signature', async () => {
    // verifyBundle turns MALFORMED base64 into `false` — a bad signature is not
    // an exception. A runtime with no base64 at all is a different fact, and
    // returning `false` for it would hide a broken environment behind a
    // security verdict.
    const key = CHANNEL_TRUST_ROOTS.get(KEY_ID)!;
    await expect(
      withoutBase64(() => verifyBundle(new Uint8Array([1]), 'AAAA', key)),
    ).rejects.toThrow(/no atob\/btoa/);
    // ...while malformed input still resolves false, globals present.
    await expect(verifyBundle(new Uint8Array([1]), '!!!!', key)).resolves.toBe(
      false,
    );
  });

  it('recovers if the globals appear later — the check is not latched', () => {
    // A module-load snapshot would answer once at import and refuse forever
    // afterwards, breaking any runtime that installs a polyfill late. Measured:
    // that is exactly what an earlier `const HAS_BASE64` did.
    withoutBase64(() => {
      expect(() => base64ToBytes('AAAA')).toThrow();
    });
    expect([...base64ToBytes(bytesToBase64(new Uint8Array([1, 2, 3])))]).toEqual([
      1, 2, 3,
    ]);
  });
});

describe('vendored constants', () => {
  it('points at the production channel', () => {
    expect(CHANNEL_CATALOG_URL).toBe('https://apps.lloyal.ai/v1/abilities/catalog.json');
  });

  it('lists exactly the vendored key ids', () => {
    expect([...CHANNEL_TRUST_ROOTS.keys()]).toEqual([KEY_ID]);
    expect(CHANNEL_TRUST_ROOTS.size).toBe(1);
    expect(CHANNEL_TRUST_ROOTS.has(KEY_ID)).toBe(true);
  });
});

describe('the trust anchor cannot be replaced at runtime', () => {
  // These replace an earlier assertion that checked `Object.isFrozen` on the
  // exported Map. It passed, and it was worthless: `Object.freeze` seals an
  // object's own properties, but a Map's entries live in internal slots it
  // cannot reach, so `set`/`delete`/`clear` kept working and the `ReadonlyMap`
  // type is erased at runtime. Any module in the process could have installed
  // its own key and had a catalog it signed itself verify. These check the
  // property that actually matters rather than a proxy for it.

  it('exposes no mutator at all', () => {
    const m = CHANNEL_TRUST_ROOTS as unknown as Record<string, unknown>;
    for (const mutator of ['set', 'delete', 'clear']) {
      expect(m[mutator]).toBeUndefined();
    }
  });

  it('will not let the accessor itself be shadowed on the instance', () => {
    // Without a frozen instance the wrapper buys nothing: assigning over `get`
    // substitutes the anchor for every consumer without touching the Map.
    // Modules are strict mode, so the assignment throws rather than no-oping.
    expect(() => {
      (CHANNEL_TRUST_ROOTS as unknown as Record<string, unknown>).get = () =>
        new Uint8Array(32);
    }).toThrow(TypeError);
    expect(sha256(CHANNEL_TRUST_ROOTS.get(KEY_ID)!)).toBe(KEY_SHA256);
  });

  it('will not let the accessor be patched on the prototype', () => {
    // The same substitution one level up, which would hit every holder of the
    // object rather than one reference.
    const proto = Object.getPrototypeOf(CHANNEL_TRUST_ROOTS) as object;
    expect(Object.isFrozen(proto)).toBe(true);
    expect(() => {
      (proto as Record<string, unknown>).get = () => new Uint8Array(32);
    }).toThrow(TypeError);
    expect(sha256(CHANNEL_TRUST_ROOTS.get(KEY_ID)!)).toBe(KEY_SHA256);
  });

  it('is still a working ReadonlyMap after being frozen', () => {
    // Freezing must not break the interface it claims to implement — `size` is
    // a getter on the frozen prototype, and iteration must still yield copies.
    expect(CHANNEL_TRUST_ROOTS.size).toBe(1);
    expect(CHANNEL_TRUST_ROOTS.has(KEY_ID)).toBe(true);
    expect([...CHANNEL_TRUST_ROOTS.keys()]).toEqual([KEY_ID]);
    expect([...CHANNEL_TRUST_ROOTS.entries()][0][0]).toBe(KEY_ID);
  });

  it('hands out a COPY of the key bytes, not the live anchor', async () => {
    const a = CHANNEL_TRUST_ROOTS.get(KEY_ID)!;
    const b = CHANNEL_TRUST_ROOTS.get(KEY_ID)!;
    expect(a).not.toBe(b);

    // Corrupting a returned copy must not affect anyone else's lookup...
    a.fill(0);
    expect(sha256(CHANNEL_TRUST_ROOTS.get(KEY_ID)!)).toBe(KEY_SHA256);

    // ...and the real catalog must still verify afterwards.
    await expect(
      verifyCatalogSignature(catalog, CHANNEL_TRUST_ROOTS.get(KEY_ID)!),
    ).resolves.toBe(true);
  });

  it('copies through every enumeration path, not just get()', () => {
    // A reader that forgot one of these would leak a writable view of the
    // anchor just as surely as an exposed `set`.
    for (const [, v] of CHANNEL_TRUST_ROOTS) v.fill(0);
    for (const v of CHANNEL_TRUST_ROOTS.values()) v.fill(0);
    CHANNEL_TRUST_ROOTS.forEach((v) => v.fill(0));
    expect(sha256(CHANNEL_TRUST_ROOTS.get(KEY_ID)!)).toBe(KEY_SHA256);
  });

  it('has no key for an id it does not vendor', () => {
    expect(CHANNEL_TRUST_ROOTS.get('attacker-key-2026')).toBeUndefined();
    expect(CHANNEL_TRUST_ROOTS.has('attacker-key-2026')).toBe(false);
  });
});

describe('isWellFormedCatalog validates entries, not just the top level', () => {
  // The predicate asserts `value is SignedCatalog` and callers dereference
  // `entry.name` / `entry.versions` on that promise, so checking only
  // `Array.isArray(entries)` was unsound.
  const base = { signedAt: '', publisherKeyId: '', signature: '' };

  it('rejects a null entry', () => {
    expect(isWellFormedCatalog({ ...base, entries: [null] })).toBe(false);
  });

  it('rejects an entry missing name or versions', () => {
    expect(isWellFormedCatalog({ ...base, entries: [{ versions: [] }] })).toBe(false);
    expect(isWellFormedCatalog({ ...base, entries: [{ name: 'a' }] })).toBe(false);
  });

  it('rejects a version missing a signed field', () => {
    const version = {
      version: '1.0.0',
      manifestUrl: 'u',
      tarballUrl: 'u',
      sizeBytes: 1,
      importName: 'n',
    };
    expect(
      isWellFormedCatalog({ ...base, entries: [{ name: 'a', versions: [version] }] }),
    ).toBe(true);
    for (const drop of Object.keys(version)) {
      const partial: Record<string, unknown> = { ...version };
      delete partial[drop];
      expect(
        isWellFormedCatalog({ ...base, entries: [{ name: 'a', versions: [partial] }] }),
      ).toBe(false);
    }
  });

  it('tolerates unknown fields so a newer catalog still validates', () => {
    const withExtra = JSON.parse(JSON.stringify(shapeValidCatalog)) as Record<string, unknown>;
    (withExtra.entries as Record<string, unknown>[])[0].futureField = 'x';
    expect(isWellFormedCatalog(withExtra)).toBe(true);
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
