/**
 * Signed-tarball App distribution — verify primitives.
 *
 * Apps are distributed as signed npm tarballs through the canonical
 * channel at {@link CHANNEL_CATALOG_URL}. The `harness.dev install` CLI
 * uses the primitives here ({@link verifyBundle}, {@link resolveAppEntry})
 * to fetch + signature-verify a tarball against
 * {@link CHANNEL_TRUST_ROOTS}, then shells out to `npm install <URL>` so
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
 * signature against {@link CHANNEL_TRUST_ROOTS}, and resolves a name +
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

/**
 * Manifest describing a signed tarball, served at the `manifestUrl`
 * listed in a catalog entry. The manifest is the publisher-of-record
 * payload that ties (tarball bytes ↔ Ed25519 signature ↔ npm-compatible
 * sha512 integrity ↔ identifying metadata) together.
 */
export interface AppBundleManifest {
  /** App identifier (matches `App.manifest.name`). */
  name: string;
  /** Semver of this release. */
  version: string;
  /**
   * Filename of the tarball relative to the channel's bundle directory
   * (e.g., `web-1.2.0.tgz`). The canonical record of what was signed —
   * `signature` is over the bytes of this artifact.
   */
  entry: string;
  /** Base64-encoded Ed25519 signature over the tarball bytes. */
  signature: string;
  /**
   * npm-compatible Subresource Integrity hash over the tarball bytes
   * (e.g., `sha512-<base64>`). `npm install` verifies this on extract
   * as defense-in-depth; the Ed25519 `signature` above is the
   * authoritative trust boundary, but the SRI hash carries trust
   * forward into the consumer's `package-lock.json` so subsequent
   * `npm ci` reproduces the install without re-verifying the
   * signature.
   */
  integrity: string;
  /**
   * Identifier of the publisher's signing key. Looked up in
   * {@link CHANNEL_TRUST_ROOTS} to obtain the verifying key.
   */
  publisherKeyId: string;
  /** Tarball size in bytes (sanity check vs. download). */
  sizeBytes: number;
  /**
   * peerDependencies of the app (e.g., `{"@lloyal-labs/rig":
   * "^3.0.0"}`). Informational; npm enforces these on install.
   */
  peerDependencies?: Record<string, string>;
}

/**
 * One version's entry in the catalog (under an app's `versions` array).
 */
export interface CatalogVersion {
  /** Semver of this release. */
  version: string;
  /** URL the manifest JSON is served from. */
  manifestUrl: string;
  /**
   * URL the signed tarball (`.tgz`) is served from. This URL is
   * immutable per version: republishing forces a new semver. The
   * `harness.dev install` CLI passes this URL straight to
   * `npm install`, and it lands verbatim in the consumer's
   * `package.json` and `package-lock.json` so CI can reproduce the
   * install with plain `npm ci` against no Lloyal tooling.
   */
  tarballUrl: string;
  /** App-protocol version this artifact targets (e.g., `'3.0'`). */
  appProtocolVersion: string;
  /** Tarball size in bytes (sanity check vs. download). */
  sizeBytes: number;
}

/**
 * One app's entry in the catalog.
 */
export interface CatalogEntry {
  /** App identifier (matches `manifest.name`). */
  name: string;
  /** Published versions, unordered. */
  versions: readonly CatalogVersion[];
}

/**
 * The full signed catalog served at {@link CHANNEL_CATALOG_URL}.
 *
 * The signature is over a canonical-JSON encoding of
 * `{ signedAt, entries, publisherKeyId }` (sorted keys, no whitespace).
 */
export interface SignedCatalog {
  /** ISO-8601 timestamp of when the catalog was signed. */
  signedAt: string;
  /** All apps published to the channel. */
  entries: readonly CatalogEntry[];
  /**
   * Identifier of the platform key that signed this catalog. Looked up
   * in {@link CHANNEL_TRUST_ROOTS}.
   */
  publisherKeyId: string;
  /** Base64-encoded Ed25519 signature. */
  signature: string;
}

/**
 * Raised when a tarball, manifest, or catalog fails signature, size,
 * or trust-roots verification. Distinct from network errors raised by
 * `cancellableFetch`.
 */
export class BundleVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleVerificationError';
  }
}

/**
 * Raised when {@link resolveAppEntry} cannot resolve the requested
 * `(name, semver)` tuple against the catalog. Distinct from
 * {@link BundleVerificationError}: the catalog was reached and verified,
 * the name is just not listed (or no version matched the semver range).
 */
export class AppNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppNotFoundError';
  }
}

// ── Test-only injection (NODE_ENV=test) ─────────────────────────────
//
// bundle.test.ts overrides the framework-vendored CHANNEL_TRUST_ROOTS +
// CHANNEL_CATALOG_URL via the helpers below so it can exercise the
// verification flow against a fresh test keypair + a local HTTP / file://
// catalog fixture. The overrides are inert outside NODE_ENV=test —
// `getTrustRoots()` / `getCatalogUrl()` consult them only when the
// environment names the test runner.

let testTrustRoots: Map<string, Uint8Array> | undefined;
let testCatalogUrl: string | undefined;

/**
 * Test-only: override {@link CHANNEL_TRUST_ROOTS} with a map containing
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
  bytes: Uint8Array; // canonical-JSON bytes that were signed, for diagnostics
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
 * Verify an Ed25519 signature over `bytes` using `publicKey` (32-byte
 * raw key). Returns `true` if the signature is authentic; `false`
 * otherwise. `crypto.subtle.verify` is async so the function returns a
 * `Promise<boolean>`; callers `yield* call(() => verifyBundle(...))` to
 * bridge.
 */
export async function verifyBundle(
  bytes: Uint8Array,
  signatureBase64: string,
  publicKey: Uint8Array,
): Promise<boolean> {
  let signature: Uint8Array;
  try {
    signature = base64ToBytes(signatureBase64);
  } catch {
    return false;
  }
  if (publicKey.byteLength !== 32) return false;
  if (signature.byteLength !== 64) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(publicKey),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    toArrayBuffer(signature),
    toArrayBuffer(bytes),
  );
}

/**
 * Canonical-JSON encoding for signature payloads. Sorts object keys
 * recursively and emits compact (no-whitespace) output. Arrays preserve
 * insertion order. Numbers, booleans, null, and strings round-trip via
 * `JSON.stringify`. Sufficient for `signedAt: ISO8601`, `publisherKeyId:
 * string`, and the `entries` tree (all string / number primitives).
 *
 * Not a full RFC 8785 implementation — explicitly. The catalog schema
 * is constrained to JSON types this helper handles correctly, and an
 * RFC 8785 dep would be overkill for the surface area.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(',')}}`;
}

/**
 * Compute the signed payload bytes for a catalog: canonical-JSON of
 * `{ signedAt, entries, publisherKeyId }`, UTF-8 encoded. Used by both
 * the verifier (here) and the signer (out-of-repo publish tooling).
 */
function catalogSignedBytes(
  signedAt: string,
  entries: readonly CatalogEntry[],
  publisherKeyId: string,
): Uint8Array {
  const json = canonicalJson({ signedAt, entries, publisherKeyId });
  return new TextEncoder().encode(json);
}

/**
 * Fetch the catalog from {@link CHANNEL_CATALOG_URL}, verify its
 * signature against {@link CHANNEL_TRUST_ROOTS}, and return the verified
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

  if (
    typeof catalog.signedAt !== 'string' ||
    !Array.isArray(catalog.entries) ||
    typeof catalog.publisherKeyId !== 'string' ||
    typeof catalog.signature !== 'string'
  ) {
    throw new BundleVerificationError(
      `Catalog at ${url} is missing required fields (signedAt, entries, publisherKeyId, signature).`,
    );
  }

  const trustKey = getTrustRoots().get(catalog.publisherKeyId);
  if (!trustKey) {
    throw new BundleVerificationError(
      `Catalog at ${url} is signed by publisherKeyId="${catalog.publisherKeyId}" ` +
        `which is not in CHANNEL_TRUST_ROOTS. The framework refuses to trust ` +
        `keys it does not vendor.`,
    );
  }

  const signedBytes = catalogSignedBytes(
    catalog.signedAt,
    catalog.entries,
    catalog.publisherKeyId,
  );
  const ok = yield* call(() => verifyBundle(signedBytes, catalog.signature, trustKey));
  if (!ok) {
    throw new BundleVerificationError(
      `Catalog at ${url} failed Ed25519 signature verification ` +
        `(publisherKeyId="${catalog.publisherKeyId}"). The catalog was tampered with ` +
        `or the publisher's signing key has changed without a corresponding rig update.`,
    );
  }

  catalogCache.set(url, { catalog, bytes: signedBytes });
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

// ── Byte helpers ───────────────────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Coerce a `Uint8Array` whose underlying buffer is `ArrayBufferLike`
 * (could be SharedArrayBuffer-backed) into a fresh `ArrayBuffer` copy.
 * WebCrypto's typed signature rejects `SharedArrayBuffer`-backed inputs.
 */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(view.byteLength);
  new Uint8Array(buf).set(view);
  return buf;
}
