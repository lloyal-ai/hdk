/**
 * Signed-tarball App distribution — verify primitives.
 *
 * Apps are distributed as signed npm tarballs through the canonical
 * channel at {@link CHANNEL_CATALOG_URL}. The `harness.dev install` CLI
 * uses the primitives here ({@link verifyBundle}, {@link resolveAppEntry})
 * to fetch + signature-verify a tarball against
 * the vendored trust roots, then shells out to `npm install <URL>` so
 * the app lands in the harness's `node_modules` like any other npm
 * dependency. The harness boots and imports each app with a plain static
 * `import`; the framework provides no runtime "load app by name" verb.
 *
 * This module exposes the verify primitives only — the file-system and
 * `npm install` shell-out live in the CLI package
 * (`@lloyal-labs/harness-cli`) so this entry remains platform-agnostic
 * (no `node:*` imports) and works in any JS runtime, including React
 * Native harnesses that might consume `@lloyal-labs/rig` for non-install
 * code paths.
 *
 * **Channel-canonical resolution.** {@link resolveAppEntry} fetches the
 * catalog from {@link CHANNEL_CATALOG_URL}, verifies its Ed25519
 * signature against the vendored trust roots, and resolves a name +
 * semver range to a {@link CatalogVersion} descriptor (manifestUrl +
 * tarballUrl + sizeBytes). The caller never supplies a URL or a trust
 * map — to use a different channel, fork `@lloyal-labs/rig` and edit
 * the constants in `protocol.ts`.
 *
 * **Verification is the entire trust boundary.** `verifyBundle` runs
 * before `harness.dev install` invokes `npm install <tarball-URL>`, so
 * a tampered tarball never reaches `npm install`. Once installed, the
 * lockfile's sha512 `integrity` field carries that trust forward for
 * subsequent `npm ci` reproduction (immutable tarball URL → same bytes
 * forever → same sha512 → same Ed25519 chain).
 *
 * @packageDocumentation
 * @category Protocol
 */

import { call } from 'effection';
import type { Operation } from 'effection';
import { satisfies, rcompare } from 'semver';
import { cancellableFetch } from './cancellable-fetch';
import { CHANNEL_CATALOG_URL, CHANNEL_TRUST_ROOTS } from './protocol';
import {
  verifyBundle,
  canonicalJson,
  catalogSignedBytes,
  verifyCatalogSignature,
  isWellFormedCatalog,
  BundleVerificationError,
  AppNotFoundError,
} from '@lloyal-labs/channel-verify';
import type {
  AppBundleManifest,
  CatalogVersion,
  CatalogEntryMetadata,
  CatalogEntry,
  SignedCatalog,
} from '@lloyal-labs/channel-verify';

/**
 * The signed-channel schemas and error types, defined in
 * `@lloyal-labs/channel-verify` and re-exported here unchanged.
 *
 * They were previously declared here AND, verbatim, in the install CLI — which
 * could not import them: rig's entry chain-imports the App runtime and the
 * native `@lloyal-labs/lloyal.node`, and a CLI that scaffolds projects must not
 * drag a native binary onto the user's platform. The shared package removes
 * the reason for the duplication rather than just the duplication.
 */
export type {
  AppBundleManifest,
  CatalogVersion,
  CatalogEntryMetadata,
  CatalogEntry,
  SignedCatalog,
};
export { BundleVerificationError, AppNotFoundError };

// ── Test-only injection (NODE_ENV=test) ─────────────────────────────
//
// bundle.test.ts overrides the framework-vendored trust roots +
// CHANNEL_CATALOG_URL via the helpers below so it can exercise the
// verification flow against a fresh test keypair + a local HTTP / file://
// catalog fixture. The overrides are inert outside NODE_ENV=test —
// `getTrustRoots()` / `getCatalogUrl()` consult them only when the
// environment names the test runner.

let testTrustRoots: Map<string, Uint8Array> | undefined;
let testCatalogUrl: string | undefined;

/**
 * Test-only: override the vendored trust roots with a map containing
 * exactly the (keyId, publicKey) pair given. Subsequent
 * {@link resolveAppEntry} calls (and the internal catalog-verification
 * path) use this override instead of the framework-vendored constant.
 * Only active when `process.env.NODE_ENV === 'test'`.
 *
 * @internal
 */
export function setTestTrustRoot(keyId: string, key: Uint8Array): void {
  testTrustRoots = new Map([[keyId, key]]);
}

/**
 * Test-only: override {@link CHANNEL_CATALOG_URL} with the given URL.
 * Useful for pointing the resolver at a `file://` or `http://localhost:N`
 * fixture during unit tests. Only active when
 * `process.env.NODE_ENV === 'test'`.
 *
 * @internal
 */
export function setTestCatalogUrl(url: string): void {
  testCatalogUrl = url;
}

/**
 * Test-only: clear both overrides. Call from `afterEach` to keep test
 * isolation clean.
 *
 * @internal
 */
export function clearTestOverrides(): void {
  testTrustRoots = undefined;
  testCatalogUrl = undefined;
}

function isTestEnv(): boolean {
  return (
    typeof process !== 'undefined' &&
    process.env != null &&
    process.env.NODE_ENV === 'test'
  );
}

function getTrustRoots(): ReadonlyMap<string, Uint8Array> {
  if (isTestEnv() && testTrustRoots) return testTrustRoots;
  return CHANNEL_TRUST_ROOTS;
}

function getCatalogUrl(): string {
  if (isTestEnv() && testCatalogUrl) return testCatalogUrl;
  return CHANNEL_CATALOG_URL;
}

// ── Per-process catalog cache ──────────────────────────────────────
//
// A boot session may resolve several apps from the same catalog
// (preflight probe + multiple registry.enable calls; install CLI
// resolving several names in one invocation). Fetch + verify the
// catalog once per (effective URL, signedAt) tuple. The cache is keyed
// by the URL so test-override switches between fixtures don't poison
// each other; it's NOT a TTL cache — within a boot session staleness is
// acceptable, across sessions the cache is gone anyway.

interface CachedCatalog {
  catalog: SignedCatalog;
}

const catalogCache = new Map<string, CachedCatalog>();

/**
 * Test-only: drop the per-process catalog cache. Use in `afterEach` to
 * guarantee a fresh catalog fetch per test.
 *
 * @internal
 */
export function clearCatalogCache(): void {
  catalogCache.clear();
}

// ── Verification primitives ────────────────────────────────────────

/**
 * The Ed25519 primitive and the canonical-JSON encoding that defines the
 * catalog signature. All three live in `@lloyal-labs/channel-verify` and are
 * re-exported here, unchanged, so rig's public surface is untouched.
 *
 * Four copies of this encoding used to exist — the publish worker (which
 * signs), this file, the install CLI, and rig's own test file, which mirrored
 * the helper to use as its oracle. They were byte-identical, but nothing
 * enforced it, and a copy that drifts does not fail loudly: it makes every
 * published app uninstallable. The shared package is pinned against frozen
 * bytes from a real signed catalog, which is the only check a coordinated
 * edit to signer and verifier cannot satisfy.
 */
export { verifyBundle, canonicalJson, catalogSignedBytes };

/**
 * Fetch the catalog from {@link CHANNEL_CATALOG_URL}, verify its
 * signature against the vendored trust roots, and return the verified
 * structure. Memoized per-process per effective URL.
 */
function* fetchAndVerifyCatalog(): Operation<SignedCatalog> {
  const url = getCatalogUrl();
  const cached = catalogCache.get(url);
  if (cached) return cached.catalog;

  const response = yield* cancellableFetch(url);
  if (!response.ok) {
    throw new BundleVerificationError(
      `Catalog fetch from ${url} returned HTTP ${response.status} ${response.statusText}.`,
    );
  }
  const text = yield* call(() => response.text());

  let catalog: SignedCatalog;
  try {
    catalog = JSON.parse(text) as SignedCatalog;
  } catch (err) {
    throw new BundleVerificationError(
      `Catalog at ${url} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Shape and signature checks come from channel-verify so the SIGNED FIELD
  // SET has one definition — adding a field to the payload must be one edit,
  // since missing it here would mean verifying over bytes this file never
  // reconstructs. The wording below stays rig's own.
  if (!isWellFormedCatalog(catalog)) {
    throw new BundleVerificationError(
      `Catalog at ${url} is missing required fields (signedAt, entries, publisherKeyId, signature).`,
    );
  }

  const trustKey = getTrustRoots().get(catalog.publisherKeyId);
  if (!trustKey) {
    throw new BundleVerificationError(
      `Catalog at ${url} is signed by publisherKeyId="${catalog.publisherKeyId}" ` +
        `which is not a vendored trust root. The framework refuses to trust ` +
        `keys it does not vendor.`,
    );
  }

  const ok = yield* call(() => verifyCatalogSignature(catalog, trustKey));
  if (!ok) {
    throw new BundleVerificationError(
      `Catalog at ${url} failed Ed25519 signature verification ` +
        `(publisherKeyId="${catalog.publisherKeyId}"). The catalog was tampered with ` +
        `or the publisher's signing key has changed without a corresponding rig update.`,
    );
  }

  // `bytes` used to be cached alongside "for diagnostics" and was never read;
  // recomputing it just to store it canonicalised the whole catalog a second
  // time on every cache miss, since verifyCatalogSignature derives its own.
  catalogCache.set(url, { catalog });
  return catalog;
}

/**
 * Resolve a name + optional semver range against the verified catalog.
 * Returns the highest-matching version's catalog entry, or throws
 * {@link AppNotFoundError} if the name is absent or no version matches.
 *
 * Consumers (notably the `harness.dev install` CLI) then fetch the
 * returned `manifestUrl` + `tarballUrl`, run {@link verifyBundle}
 * against the manifest's signature over the tarball bytes, and shell
 * out to `npm install <tarballUrl>` to install the verified package.
 */
export function* resolveAppEntry(
  name: string,
  opts: { semver?: string } = {},
): Operation<CatalogVersion> {
  const catalog = yield* fetchAndVerifyCatalog();
  const entry = catalog.entries.find((e) => e.name === name);
  if (!entry) {
    throw new AppNotFoundError(
      `App "${name}" is not listed in the catalog at ${getCatalogUrl()}.`,
    );
  }
  const range = opts.semver;
  const matching = range
    ? entry.versions.filter((v) => {
        try {
          return satisfies(v.version, range);
        } catch {
          return false;
        }
      })
    : [...entry.versions];
  if (matching.length === 0) {
    const available = entry.versions.map((v) => v.version).join(', ') || '(none published)';
    throw new AppNotFoundError(
      `App "${name}" has no version matching "${range ?? '*'}". ` +
        `Published versions: ${available}.`,
    );
  }
  matching.sort((a, b) => rcompare(a.version, b.version));
  return matching[0];
}
