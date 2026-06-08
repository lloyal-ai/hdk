/**
 * Tests for `harness-cli/src/verify.ts` — the install-time verify
 * primitives that duplicate `@lloyal-labs/rig`'s bundle-verification
 * surface (see verify.ts header for the "why duplicate" rationale).
 *
 * Critical invariants under test:
 *
 * 1. **verifyBundle round-trips** — happy path, tamper detection,
 *    malformed inputs all reject.
 * 2. **sha512Integrity matches Node's crypto digest** — the install
 *    audit step depends on this exactly equalling what npm computes
 *    and writes into package-lock.json.
 * 3. **resolveAppVersion semver semantics** — exact, ^caret, ~tilde,
 *    `*` wildcard, AppNotFoundError on no-match.
 *
 * Network paths (fetchAndVerifyCatalog, fetchAndVerifyManifest) are
 * exercised by the end-to-end install gate in Phase Z.5 — they're
 * trivial wrappers around fetch + verifyBundle and would just
 * re-test the primitives below.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  verifyBundle,
  sha512Integrity,
  resolveAppVersion,
  AppNotFoundError,
  type SignedCatalog,
} from '../src/verify';

async function generateKeypair(): Promise<{ publicKey: Uint8Array; signKey: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { publicKey: rawPub, signKey: kp.privateKey };
}

async function signBytes(key: CryptoKey, bytes: Uint8Array): Promise<string> {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, buf));
  let s = '';
  for (let i = 0; i < sig.length; i++) s += String.fromCharCode(sig[i]);
  return btoa(s);
}

describe('verifyBundle', () => {
  it('returns true for an authentic Ed25519 signature', async () => {
    const { publicKey, signKey } = await generateKeypair();
    const bytes = new TextEncoder().encode('hello tarball');
    const sig = await signBytes(signKey, bytes);
    expect(await verifyBundle(bytes, sig, publicKey)).toBe(true);
  });

  it('returns false when payload bytes are tampered', async () => {
    const { publicKey, signKey } = await generateKeypair();
    const bytes = new TextEncoder().encode('hello tarball');
    const sig = await signBytes(signKey, bytes);
    const tampered = new Uint8Array(bytes);
    tampered[0] ^= 0x01;
    expect(await verifyBundle(tampered, sig, publicKey)).toBe(false);
  });

  it('returns false for wrong-length signature', async () => {
    const { publicKey } = await generateKeypair();
    expect(await verifyBundle(new Uint8Array(8), btoa('short'), publicKey)).toBe(false);
  });

  it('returns false for invalid base64 signature', async () => {
    const { publicKey } = await generateKeypair();
    expect(await verifyBundle(new Uint8Array(8), '!!! not base64 !!!', publicKey)).toBe(false);
  });

  it('returns false for wrong-length public key', async () => {
    const { signKey } = await generateKeypair();
    const bytes = new TextEncoder().encode('payload');
    const sig = await signBytes(signKey, bytes);
    expect(await verifyBundle(bytes, sig, new Uint8Array(16))).toBe(false);
  });
});

describe('sha512Integrity', () => {
  it('matches Node native sha512 over the same bytes', async () => {
    const bytes = new TextEncoder().encode('the quick brown fox');
    const ours = await sha512Integrity(bytes);
    // Reference computation using Node's native crypto (same code path as
    // the npm CLI uses to populate package-lock.json integrity fields).
    const reference = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    expect(ours).toBe(reference);
  });

  it('produces sha512-<base64> format', async () => {
    const out = await sha512Integrity(new Uint8Array([1, 2, 3]));
    expect(out.startsWith('sha512-')).toBe(true);
    // base64 alphabet only (and a single trailing == for short inputs)
    expect(out.slice('sha512-'.length)).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe('resolveAppVersion', () => {
  function makeCatalog(): SignedCatalog {
    return {
      signedAt: '2026-06-07T00:00:00Z',
      publisherKeyId: 'lloyal-platform-2026-q2',
      signature: 'unused-for-this-test',
      entries: [
        {
          name: 'web',
          versions: [
            v('1.0.0'),
            v('1.0.3'),
            v('1.2.5'),
            v('2.0.0'),
            v('2.1.0-beta.1'),
          ],
        },
        {
          name: 'corpus',
          versions: [v('1.0.0')],
        },
      ],
    };

    function v(version: string) {
      return {
        version,
        manifestUrl: `https://apps.lloyal.ai/v1/bundles/web-${version}.manifest.json`,
        tarballUrl: `https://apps.lloyal.ai/v1/bundles/web-${version}.tgz`,
        appProtocolVersion: '3.0',
        sizeBytes: 1024,
        importName: '@lloyal-labs/web-app',
      };
    }
  }

  it('picks highest version with no range (default)', () => {
    const out = resolveAppVersion(makeCatalog(), 'web');
    // 2.1.0-beta.1 has a higher core than 2.0.0, so it wins. Matches
    // rig's `rcompare`-based ordering — the "release > prerelease"
    // tiebreaker only applies when cores are equal. Consumers who want
    // to avoid prereleases should pin a range like `^1.0.0` or `^2.0.0`.
    expect(out.version).toBe('2.1.0-beta.1');
  });

  it('picks highest matching with ^caret', () => {
    expect(resolveAppVersion(makeCatalog(), 'web', { semver: '^1.0.0' }).version).toBe('1.2.5');
    expect(resolveAppVersion(makeCatalog(), 'web', { semver: '^1.0.3' }).version).toBe('1.2.5');
    expect(resolveAppVersion(makeCatalog(), 'web', { semver: '^2.0.0' }).version).toBe('2.0.0');
  });

  it('picks highest matching with ~tilde', () => {
    expect(resolveAppVersion(makeCatalog(), 'web', { semver: '~1.0.0' }).version).toBe('1.0.3');
    expect(resolveAppVersion(makeCatalog(), 'web', { semver: '~1.2.0' }).version).toBe('1.2.5');
  });

  it('picks exact match with bare version', () => {
    expect(resolveAppVersion(makeCatalog(), 'web', { semver: '1.0.0' }).version).toBe('1.0.0');
    expect(resolveAppVersion(makeCatalog(), 'web', { semver: '1.2.5' }).version).toBe('1.2.5');
  });

  it('returns highest including prereleases under * wildcard', () => {
    const onlyPre: SignedCatalog = {
      ...makeCatalog(),
      entries: [
        {
          name: 'foo',
          versions: [
            { version: '0.1.0-alpha.1', manifestUrl: 'x', tarballUrl: 'y', appProtocolVersion: '3.0', sizeBytes: 1, importName: '@lloyal-labs/foo' },
          ],
        },
      ],
    };
    expect(resolveAppVersion(onlyPre, 'foo', { semver: '*' }).version).toBe('0.1.0-alpha.1');
  });

  it('throws AppNotFoundError for unknown name', () => {
    expect(() => resolveAppVersion(makeCatalog(), 'jira')).toThrow(AppNotFoundError);
  });

  it('throws AppNotFoundError when no version matches', () => {
    expect(() => resolveAppVersion(makeCatalog(), 'web', { semver: '^3.0.0' })).toThrow(AppNotFoundError);
  });

  it('rejects unsupported semver syntax with a clear message', () => {
    expect(() => resolveAppVersion(makeCatalog(), 'web', { semver: '>=1.0.0' })).toThrow(
      /unsupported semver range/,
    );
  });
});
