/**
 * Rig's end of the drift gate.
 *
 * The encoding itself lives in `@lloyal-labs/channel-verify` and is pinned
 * there against golden vectors and this same frozen catalog. What THIS file
 * asserts is the seam: that rig's own surface — the symbols `index.ts`
 * re-exports and `resolveAbilityEntry` verifies with — still resolves to a
 * verifier that accepts bytes the platform actually signed.
 *
 * That is not covered by channel-verify's own suite. A broken re-export, a
 * dependency bumped to a version whose encoding drifted, or a stray local
 * redefinition would all leave that suite green while no ability would load. It is
 * worth its few milliseconds precisely because it fails for reasons the
 * dependency's tests cannot see.
 *
 * The fixture is FROZEN — the live catalog as served on 2026-07-29. It must
 * never be refreshed to match current production: a fixture that tracks the
 * thing it checks proves nothing. On key rotation add a second fixture rather
 * than replacing this one.
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
  type SignedCatalog,
} from '../src/bundle';
import { CHANNEL_TRUST_ROOTS } from '../src/protocol';

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(here, 'fixtures', 'prod-catalog-2026-07-29.json'), 'utf8'),
) as SignedCatalog;

const CANONICAL_BYTE_LENGTH = 4076;
const CANONICAL_SHA256 =
  '291c32d79a180ee2d9e7ba91f60178220e6a13e73aaf67855a13677e26687aa8';
const KEY_ID = 'lloyal-platform-2026-q2';
const KEY_SHA256 =
  '9e0df3d25b8968a8b2ae9b86cb17a6922368c7cff9674a84b4a2527dd6457ec1';

const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

describe('rig verifies a real signed catalog', () => {
  it('canonicalises to exactly the bytes that were signed', () => {
    const bytes = catalogSignedBytes(
      catalog.signedAt,
      catalog.entries,
      catalog.publisherKeyId,
    );
    expect(bytes.length).toBe(CANONICAL_BYTE_LENGTH);
    expect(sha256(bytes)).toBe(CANONICAL_SHA256);
  });

  it('reaches the trust root the catalog was signed with', () => {
    // Read through `protocol.ts` — rig's documented public constant — NOT
    // through `getTrustRoots()`, so the test-env override machinery cannot
    // satisfy this.
    const key = CHANNEL_TRUST_ROOTS.get(KEY_ID);
    expect(key).toBeDefined();
    expect(key!.length).toBe(32);
    expect(sha256(key!)).toBe(KEY_SHA256);
  });

  it('verifies it', async () => {
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
    // Proves the assertion above is load-bearing and not vacuous.
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
});
