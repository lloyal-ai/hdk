/**
 * Tests for {@link verifyBundle} and {@link resolveAbilityEntry} — the
 * verify primitives that back the `lloyal install` CLI.
 *
 * Behaviors verified:
 *
 * 1. **verifyBundle happy path / tamper / malformed input** — Ed25519
 *    verification primitive.
 * 2. **Catalog signature pass / fail** — the catalog must be signed by a
 *    vendored trust root; tampered bytes flip the result.
 * 3. **Semver resolution** — highest matching version wins; no match →
 *    {@link AbilityNotFoundError}; unknown name → `AbilityNotFoundError`.
 * 4. **MITM detection** — a mutated catalog (entries swapped) fails
 *    signature before the resolver looks at any name.
 * 5. **Pre-flight cache** — two `resolveAbilityEntry` calls within the same
 *    scope fetch the catalog exactly once.
 * 6. **Non-200 catalog fetch** — propagates as `BundleVerificationError`.
 *
 * Runtime-load tests for the rejected `loadBundle` model have been
 * removed; install is now the `lloyal install` CLI shelling out to
 * `npm install <tarballUrl>` after Ed25519 verification, exercised by
 * harness-cli's own test suite.
 *
 * @category Testing
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { run } from 'effection';
import {
  verifyBundle,
  resolveAbilityEntry,
  catalogSignedBytes,
  BundleVerificationError,
  AbilityNotFoundError,
  setTestTrustRoot,
  setTestCatalogUrl,
  clearTestOverrides,
  clearCatalogCache,
  type AbilityBundleManifest,
  type CatalogEntry,
  type CatalogVersion,
  type SignedCatalog,
} from '../src/bundle';

// ── Helpers: keypair + signing ───────────────────────────────────

async function generateKeypair(): Promise<{
  publicKey: Uint8Array;
  signKey: CryptoKey;
}> {
  const keypair = (await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const rawPub = new Uint8Array(
    await crypto.subtle.exportKey('raw', keypair.publicKey),
  );
  return { publicKey: rawPub, signKey: keypair.privateKey };
}

async function signBytes(key: CryptoKey, bytes: Uint8Array): Promise<string> {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'Ed25519' }, key, buf),
  );
  let s = '';
  for (let i = 0; i < sig.length; i++) s += String.fromCharCode(sig[i]);
  return btoa(s);
}

// `catalogSignedBytes` is imported from bundle.ts, not mirrored here. This
// file used to carry its own copy of it and of `canonicalJson` — a fourth
// copy of the encoding, and one that made this suite unable to detect the
// failure it most needed to: a test whose oracle is a duplicate of the code
// under test passes happily when both are wrong together. The frozen-byte
// assertions live in `catalog-golden.test.ts`; this suite signs with the real
// encoder so its catalogs are the ones the verifier would actually accept.

// ── Bundle source authoring ─────────────────────────────────────

function makeBundleSource(abilityName: string, protocolName: string): Uint8Array {
  const src = `
export default function* () {
  return {
    name: ${JSON.stringify(abilityName)},
    version: '1.0.0',
    manifest: {
      name: ${JSON.stringify(abilityName)},
      version: '1.0.0',
      appProtocolVersion: '3.0',
      protocol: {
        name: ${JSON.stringify(protocolName)},
        useWhen: 'test bundle',
        tools: ['x'],
      },
    },
    source: { name: ${JSON.stringify(abilityName)} },
    tools: [],
    skill: 'test skill template',
  };
}
`;
  return new TextEncoder().encode(src);
}

// ── Channel fixture builder ─────────────────────────────────────

interface AppFixture {
  name: string;
  version: string;
  tarballBytes: Uint8Array;
  manifestUrl: string;
  tarballUrl: string;
  manifest: AbilityBundleManifest;
}

const CATALOG_URL = 'https://test.example.com/v1/catalog.json';

async function sha512IntegrityOf(bytes: Uint8Array): Promise<string> {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', buf));
  let s = '';
  for (let i = 0; i < digest.length; i++) s += String.fromCharCode(digest[i]);
  return `sha512-${btoa(s)}`;
}

/**
 * Build one ability fixture: a stand-in tarball signed under `signKey`,
 * plus its manifest. Caller is responsible for assembling these into a
 * catalog and signing the catalog. Tests don't need a real npm tarball
 * for the verify-primitive surface — any byte sequence whose Ed25519
 * signature matches works.
 */
async function buildAppFixture(
  signKey: CryptoKey,
  publisherKeyId: string,
  name: string,
  version: string,
): Promise<AppFixture> {
  const tarballBytes = makeBundleSource(name, `${name}_research`);
  const signature = await signBytes(signKey, tarballBytes);
  const integrity = await sha512IntegrityOf(tarballBytes);
  const manifestUrl = `https://test.example.com/v1/bundles/${name}-${version}.manifest.json`;
  const tarballUrl = `https://test.example.com/v1/bundles/${name}-${version}.tgz`;
  const manifest: AbilityBundleManifest = {
    name,
    version,
    entry: `${name}-${version}.tgz`,
    signature,
    integrity,
    publisherKeyId,
    sizeBytes: tarballBytes.byteLength,
  };
  return { name, version, tarballBytes, manifestUrl, tarballUrl, manifest };
}

/**
 * Sign a catalog containing the given fixtures and return the
 * SignedCatalog object that the channel would serve.
 */
async function buildSignedCatalog(
  signKey: CryptoKey,
  publisherKeyId: string,
  fixtures: AppFixture[],
  signedAt = '2026-06-03T00:00:00.000Z',
): Promise<SignedCatalog> {
  const byName = new Map<string, CatalogVersion[]>();
  for (const f of fixtures) {
    const arr = byName.get(f.name) ?? [];
    arr.push({
      version: f.version,
      manifestUrl: f.manifestUrl,
      tarballUrl: f.tarballUrl,
      appProtocolVersion: '3.0',
      sizeBytes: f.tarballBytes.byteLength,
      importName: `@lloyal-labs/${f.name}-ability`,
    });
    byName.set(f.name, arr);
  }
  const entries: CatalogEntry[] = [...byName.entries()].map(([name, versions]) => ({
    name,
    versions,
  }));
  const bytes = catalogSignedBytes(signedAt, entries, publisherKeyId);
  const signature = await signBytes(signKey, bytes);
  return { signedAt, entries, publisherKeyId, signature };
}

/**
 * Install a global fetch stub that serves the given catalog + fixtures
 * by URL. Returns the stub for assertion (e.g., call count).
 */
function installFetchStub(
  catalog: SignedCatalog,
  fixtures: AppFixture[],
): ReturnType<typeof vi.fn> {
  const catalogBody = JSON.stringify(catalog);
  const manifestByUrl = new Map<string, string>();
  const tarballByUrl = new Map<string, Uint8Array>();
  for (const f of fixtures) {
    manifestByUrl.set(f.manifestUrl, JSON.stringify(f.manifest));
    tarballByUrl.set(f.tarballUrl, f.tarballBytes);
  }
  const stub = vi.fn(async (url: string) => {
    if (url === CATALOG_URL) return new Response(catalogBody, { status: 200 });
    const m = manifestByUrl.get(url);
    if (m !== undefined) return new Response(m, { status: 200 });
    const t = tarballByUrl.get(url);
    if (t !== undefined) {
      const buf = new ArrayBuffer(t.byteLength);
      new Uint8Array(buf).set(t);
      return new Response(buf, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', stub);
  return stub;
}

// ── Test lifecycle ──────────────────────────────────────────────

beforeEach(() => {
  setTestCatalogUrl(CATALOG_URL);
  clearCatalogCache();
});

afterEach(() => {
  clearTestOverrides();
  clearCatalogCache();
  vi.unstubAllGlobals();
});

// ── verifyBundle ────────────────────────────────────────────────

describe('verifyBundle', () => {
  it('returns true for an authentic signature', async () => {
    const { publicKey, signKey } = await generateKeypair();
    const bytes = new TextEncoder().encode('hello bundle');
    const sig = await signBytes(signKey, bytes);
    expect(await verifyBundle(bytes, sig, publicKey)).toBe(true);
  });

  it('returns false when payload bytes are tampered', async () => {
    const { publicKey, signKey } = await generateKeypair();
    const bytes = new TextEncoder().encode('hello bundle');
    const sig = await signBytes(signKey, bytes);
    const tampered = new Uint8Array(bytes);
    tampered[0] ^= 0x01;
    expect(await verifyBundle(tampered, sig, publicKey)).toBe(false);
  });

  it('returns false for a wrong-length signature', async () => {
    const { publicKey } = await generateKeypair();
    const bytes = new TextEncoder().encode('payload');
    const badSig = btoa('short');
    expect(await verifyBundle(bytes, badSig, publicKey)).toBe(false);
  });

  it('returns false for invalid base64 signature', async () => {
    const { publicKey } = await generateKeypair();
    const bytes = new TextEncoder().encode('payload');
    expect(await verifyBundle(bytes, '!!! not base64 !!!', publicKey)).toBe(false);
  });

  it('returns false for a wrong-length public key', async () => {
    const { signKey } = await generateKeypair();
    const bytes = new TextEncoder().encode('payload');
    const sig = await signBytes(signKey, bytes);
    expect(await verifyBundle(bytes, sig, new Uint8Array(16))).toBe(false);
  });
});

// ── resolveAbilityEntry ─────────────────────────────────────────────

describe('resolveAbilityEntry', () => {
  it('returns the highest-matching version for a semver range', async () => {
    const { publicKey, signKey } = await generateKeypair();
    setTestTrustRoot('test-pub', publicKey);
    const v1 = await buildAppFixture(signKey, 'test-pub', 'multi', '1.0.0');
    const v2 = await buildAppFixture(signKey, 'test-pub', 'multi', '1.2.0');
    const v3 = await buildAppFixture(signKey, 'test-pub', 'multi', '2.0.0');
    const catalog = await buildSignedCatalog(signKey, 'test-pub', [v1, v2, v3]);
    installFetchStub(catalog, [v1, v2, v3]);

    const picked = await run(function* () {
      return yield* resolveAbilityEntry('multi', { semver: '^1.0.0' });
    });
    expect(picked.version).toBe('1.2.0');

    clearCatalogCache();
    const picked2 = await run(function* () {
      return yield* resolveAbilityEntry('multi', { semver: '*' });
    });
    expect(picked2.version).toBe('2.0.0');
  });

  it('returns highest version when no semver range is given', async () => {
    const { publicKey, signKey } = await generateKeypair();
    setTestTrustRoot('test-pub', publicKey);
    const v1 = await buildAppFixture(signKey, 'test-pub', 'plain', '1.0.0');
    const v2 = await buildAppFixture(signKey, 'test-pub', 'plain', '1.5.0');
    const catalog = await buildSignedCatalog(signKey, 'test-pub', [v1, v2]);
    installFetchStub(catalog, [v1, v2]);

    const picked = await run(function* () {
      return yield* resolveAbilityEntry('plain');
    });
    expect(picked.version).toBe('1.5.0');
  });

  it('throws AbilityNotFoundError for unknown name', async () => {
    const { publicKey, signKey } = await generateKeypair();
    setTestTrustRoot('test-pub', publicKey);
    const v1 = await buildAppFixture(signKey, 'test-pub', 'web', '1.0.0');
    const catalog = await buildSignedCatalog(signKey, 'test-pub', [v1]);
    installFetchStub(catalog, [v1]);

    await expect(
      run(function* () {
        return yield* resolveAbilityEntry('jira');
      }),
    ).rejects.toBeInstanceOf(AbilityNotFoundError);
  });

  it('throws AbilityNotFoundError when no version matches the range', async () => {
    const { publicKey, signKey } = await generateKeypair();
    setTestTrustRoot('test-pub', publicKey);
    const v1 = await buildAppFixture(signKey, 'test-pub', 'ability', '1.0.0');
    const catalog = await buildSignedCatalog(signKey, 'test-pub', [v1]);
    installFetchStub(catalog, [v1]);

    await expect(
      run(function* () {
        return yield* resolveAbilityEntry('ability', { semver: '^2.0.0' });
      }),
    ).rejects.toBeInstanceOf(AbilityNotFoundError);
  });

  it('rejects a tampered catalog (MITM detection) before resolving any name', async () => {
    const { publicKey, signKey } = await generateKeypair();
    setTestTrustRoot('test-pub', publicKey);
    const v1 = await buildAppFixture(signKey, 'test-pub', 'web', '1.0.0');
    const catalog = await buildSignedCatalog(signKey, 'test-pub', [v1]);

    // Tamper the catalog: swap in an attacker-controlled tarballUrl while
    // keeping the original signature. The verifier must reject.
    const tampered: SignedCatalog = {
      ...catalog,
      entries: [
        {
          name: 'web',
          versions: [
            { ...catalog.entries[0].versions[0], tarballUrl: 'https://attacker.example/evil.tgz' },
          ],
        },
      ],
    };
    installFetchStub(tampered, [v1]);

    await expect(
      run(function* () {
        return yield* resolveAbilityEntry('web');
      }),
    ).rejects.toBeInstanceOf(BundleVerificationError);
  });

  it('rejects a catalog signed by a key not in trust roots', async () => {
    const { publicKey: trustedPub } = await generateKeypair();
    const { signKey: attackerKey } = await generateKeypair();
    setTestTrustRoot('test-pub', trustedPub); // trusted

    const v1 = await buildAppFixture(attackerKey, 'test-pub', 'web', '1.0.0');
    // Catalog claims publisherKeyId='unknown-pub' (not in trust roots).
    const catalog = await buildSignedCatalog(attackerKey, 'unknown-pub', [v1]);
    installFetchStub(catalog, [v1]);

    await expect(
      run(function* () {
        return yield* resolveAbilityEntry('web');
      }),
    ).rejects.toThrow(/not a vendored trust root/);
  });

  it('caches the verified catalog within a scope (one fetch for two resolves)', async () => {
    const { publicKey, signKey } = await generateKeypair();
    setTestTrustRoot('test-pub', publicKey);
    const v1 = await buildAppFixture(signKey, 'test-pub', 'a', '1.0.0');
    const v2 = await buildAppFixture(signKey, 'test-pub', 'b', '1.0.0');
    const catalog = await buildSignedCatalog(signKey, 'test-pub', [v1, v2]);
    const stub = installFetchStub(catalog, [v1, v2]);

    await run(function* () {
      yield* resolveAbilityEntry('a');
      yield* resolveAbilityEntry('b');
    });

    const catalogCalls = (stub.mock.calls as Array<[string, ...unknown[]]>).filter(
      ([url]) => url === CATALOG_URL,
    );
    expect(catalogCalls.length).toBe(1);
  });

  it('rejects non-200 catalog fetch as BundleVerificationError', async () => {
    const { publicKey } = await generateKeypair();
    setTestTrustRoot('test-pub', publicKey);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('forbidden', { status: 403 })),
    );

    await expect(
      run(function* () {
        return yield* resolveAbilityEntry('anything');
      }),
    ).rejects.toThrow(/Catalog fetch.*HTTP 403/);
  });
});

// Removed: describe('loadBundle', ...) and its 9 cases. The runtime
// `loadBundle` model was replaced with `lloyal install` shelling
// out to `npm install <tarballUrl>` after Ed25519 verification, which
// is exercised by harness-cli's own test suite.
