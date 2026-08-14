/**
 * `@lloyal-labs/channel-verify` — the signature primitives for the Lloyal app
 * channel. Apache-2.0, **zero dependencies, zero native binaries**, and no I/O.
 *
 * ## What this is
 *
 * The channel's trust chain is: a signed catalog names every app and pins each
 * version's `manifestUrl` / `tarballUrl` / `sizeBytes`; each bundle's manifest
 * carries an Ed25519 signature over the **raw tarball bytes**. A client that
 * can (a) reproduce the exact bytes the platform signed for a catalog and
 * (b) verify an Ed25519 signature can establish everything else by
 * cross-checking against the verified catalog.
 *
 * Those two capabilities are what live here, and nothing else.
 *
 * ## Why it exists
 *
 * Four copies of this encoding existed: the publish worker (which signs),
 * `@lloyal-labs/rig` (which verifies in-process), the CLI (which verifies at
 * install time), and rig's own test file, which mirrored the helper to use as
 * its oracle. They were byte-identical — verified by mechanical diff, not by
 * eye — but nothing enforced that, and a copy that drifts does not fail
 * loudly: it makes every published app uninstallable.
 *
 * The CLI's copy existed for a concrete reason, which this package also
 * resolves. Importing rig pulls in the App runtime, which chain-imports
 * `@lloyal-labs/lloyal-agents` → `@lloyal-labs/sdk` → the native
 * `@lloyal-labs/lloyal.node`. A CLI that scaffolds projects must not require a
 * native binary on the user's platform, so it duplicated the surface instead.
 * This package is the shared home that costs neither side anything: pure
 * WebCrypto and string manipulation, so it runs unmodified in Node, in a
 * browser, and on workerd.
 *
 * ## What deliberately stays with each consumer
 *
 * Only provably-identical code is shared. Three things are not:
 *
 * - **Fetching.** rig's verifier is an Effection `Operation` with a memoizing
 *   cache and a cancellable fetch; the CLI's is `async`/`await` with a
 *   headers-deadline tuned for multi-gigabyte model pulls. Same trust chain,
 *   different runtimes, and neither belongs to the other.
 * - **Error prose.** rig explains that the framework refuses to trust keys it
 *   does not vendor; the CLI is terse. Unifying the wording would change
 *   user-visible behaviour in one of them to no benefit, so each keeps its own
 *   and composes the checks below.
 * - **Version resolution.** rig uses node-semver; the CLI hand-rolls a matcher
 *   to stay dependency-free, and they genuinely disagree — on `'*'` against a
 *   prerelease, and on `'>=1.0.0'`, which one accepts and the other rejects.
 *   Merging them would silently change which version of an app gets installed.
 *   That is a decision to make deliberately, not a side effect of
 *   de-duplication.
 *
 * @packageDocumentation
 */

// ── Framework-vendored constants ──────────────────────────────────────

/**
 * The canonical channel catalog URL. Clients never accept a URL argument — to
 * point at a different channel, fork this package and edit the constant.
 */
export const CHANNEL_CATALOG_URL = 'https://apps.lloyal.ai/v1/catalog.json';

/**
 * The current Lloyal platform Ed25519 public key (raw 32 bytes) —
 * `lloyal-platform-2026-q2`.
 *
 * SHA-256 fingerprint: 9e0df3d25b8968a8b2ae9b86cb17a6922368c7cff9674a84b4a2527dd6457ec1
 * Base64: bUz2SCkISzbzD4/WftUw4Nou2bJixs6OYh/5lomQylI=
 *
 * The private half never leaves the publish worker's secret store. This being
 * the single vendored copy is the point: it previously appeared verbatim in two
 * packages, and the key-rotation runbook named only one of them.
 *
 * Module-private, and deliberately not exported: handing out the live
 * `Uint8Array` would hand out a writable view of the trust anchor.
 */
const LLOYAL_PLATFORM_KEY_2026_Q2 = new Uint8Array([
  109, 76, 246, 72, 41, 8, 75, 54, 243, 15, 143, 214, 126, 213, 48, 224, 218,
  46, 217, 178, 98, 198, 206, 142, 98, 31, 249, 150, 137, 144, 202, 82,
]);

/**
 * Trust roots — `publisherKeyId` to raw Ed25519 public key bytes. Multi-entry
 * to support rotation: the new revision is added alongside the old, which stays
 * valid through its deprecation window, and is dropped in a later major.
 *
 * Module-private. Reached only through {@link trustRootFor}; see there for why
 * this is not exported as a `ReadonlyMap`.
 */
const TRUST_ROOTS = new Map<string, Uint8Array>([
  ['lloyal-platform-2026-q2', LLOYAL_PLATFORM_KEY_2026_Q2],
]);

/**
 * The verifying key for a `publisherKeyId`, or `undefined` if that id is not
 * trusted. **Returns a fresh copy on every call.**
 *
 * This replaces the exported `CHANNEL_TRUST_ROOTS` map that rig and the CLI
 * each used to vendor, which was `Object.freeze`d and typed `ReadonlyMap` —
 * and was neither. Measured, not assumed:
 *
 * ```
 * Object.isFrozen(map)      : true
 * map.set("evil", attacker) : SUCCEEDED
 * map.delete("lloyal-…")    : SUCCEEDED
 * ```
 *
 * `Object.freeze` seals an object's own properties, but a `Map`'s entries live
 * in internal slots it cannot reach, so `set`/`delete`/`clear` all still work.
 * The `ReadonlyMap` type is erased at runtime and stops nothing. Any module in
 * the process could therefore install its own trust anchor and have a catalog
 * it signed itself verify — in a package whose entire job is deciding what to
 * trust. The key bytes were mutable too, and cannot be protected in place:
 * `Object.freeze` on a `Uint8Array` with elements throws.
 *
 * A copy-returning function is the only shape that actually holds: there is no
 * live collection to mutate and no shared buffer to write through.
 */
export function trustRootFor(keyId: string): Uint8Array | undefined {
  const key = TRUST_ROOTS.get(keyId);
  return key === undefined ? undefined : new Uint8Array(key);
}

/** The trusted `publisherKeyId`s, in vendoring order. Fresh array per call. */
export function trustedKeyIds(): readonly string[] {
  return [...TRUST_ROOTS.keys()];
}

// ── Schemas ───────────────────────────────────────────────────────────

export interface AppBundleManifest {
  name: string;
  version: string;
  entry: string;
  signature: string;
  integrity: string;
  publisherKeyId: string;
  sizeBytes: number;
  peerDependencies?: Record<string, string>;
}

export interface CatalogVersion {
  version: string;
  manifestUrl: string;
  tarballUrl: string;
  appProtocolVersion: string;
  sizeBytes: number;
  /**
   * npm package name as declared in the tarball's `package.json`. The catalog
   * `name` (e.g. `lloyal/web`) is the scoped Lloyal identifier; `importName`
   * (e.g. `@lloyal-labs/web-app`) is the actual npm package installed, and the
   * symbol a harness imports from once it is on disk.
   */
  importName: string;
}

/**
 * Optional signed display/disclosure block on a catalog entry. Produced by the
 * publish worker, rendered by the storefront; verifiers do not read it. Typed
 * here so the one signed shape stays in sync. `schemaVersion` is `number`, not
 * a literal, so a future bump is tolerated rather than a type error.
 */
export interface CatalogEntryMetadata {
  schemaVersion: number;
  title: string;
  shortDesc: string;
  category: string;
  iconUrl?: string;
  entitlements: readonly string[];
}

export interface CatalogEntry {
  name: string;
  versions: readonly CatalogVersion[];
  metadata?: CatalogEntryMetadata;
}

export interface SignedCatalog {
  signedAt: string;
  entries: readonly CatalogEntry[];
  publisherKeyId: string;
  signature: string;
}

export class BundleVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleVerificationError';
  }
}

export class AppNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppNotFoundError';
  }
}

// ── Verification primitives ───────────────────────────────────────────

/**
 * Verify an Ed25519 signature over `bytes` using `publicKey` (32-byte raw
 * key). Returns `true` if the signature is authentic; `false` otherwise —
 * including for malformed base64 and wrong-length inputs, which are rejected
 * before reaching WebCrypto so a caller cannot distinguish "bad signature"
 * from "bad encoding" and act differently on the two.
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
 * Compute the npm-compatible sha512 integrity over `bytes`. Returns
 * `sha512-<base64>` — the format npm writes into `package-lock.json`, so a
 * verified tarball's integrity can be cross-checked against what npm records
 * after installing it.
 */
export async function sha512Integrity(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-512', toArrayBuffer(bytes)),
  );
  return `sha512-${bytesToBase64(digest)}`;
}

/**
 * Canonical-JSON encoding for signature payloads: object keys sorted, no
 * whitespace, arrays in insertion order.
 *
 * **This function defines the signature.** Its output IS the signed message,
 * so any change to it — a different sort comparator, escaped non-ASCII, a
 * space after a separator — invalidates every signature the platform has ever
 * produced. It is pinned against frozen bytes in `test/catalog-golden.test.ts`
 * rather than by a round-trip, because a round-trip cannot detect a change
 * applied to signer and verifier together.
 *
 * Not a general RFC 8785 implementation — but closer to one than an earlier
 * version of this comment claimed. Its output agrees with RFC 8785 on the
 * catalog's schema: keys sort by UTF-16 code unit (§3.2.3), and strings
 * serialise as ECMAScript `JSON.stringify` does (§3.2.2.2), which emits
 * non-ASCII raw. The live catalog's U+2014 is therefore *compatible* with
 * RFC 8785, not a divergence from it.
 *
 * What is missing is the validation half: no I-JSON checking, and non-finite
 * numbers silently become `null` via `JSON.stringify` where RFC 8785 requires
 * rejection. Safe here only because the input is always `JSON.parse` output
 * over a constrained schema, which can produce neither. Do not reuse this on
 * arbitrary input expecting RFC 8785 guarantees.
 *
 * One hazard it cannot defend against, recorded because the guard lives
 * elsewhere: `Object.entries` KEEPS a key whose value is `undefined` while
 * `JSON.stringify` DROPS it. A signer that signs `canonicalJson(x)` but
 * publishes `JSON.stringify(x)` therefore produces, for one explicitly-
 * undefined property, a document no client can ever verify. Verifiers are safe
 * by construction — their input is always `JSON.parse` output, which cannot
 * contain `undefined` — so the guard belongs on the signing side, where it is
 * currently held by omitting absent optional fields rather than setting them
 * to `undefined`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(',')}}`;
}

/**
 * The exact bytes the platform signs for a catalog: canonical-JSON of
 * `{ signedAt, entries, publisherKeyId }`, UTF-8 encoded.
 *
 * Note what is absent: `signature` is not part of its own payload. Field order
 * in the literal is irrelevant because keys are sorted.
 */
export function catalogSignedBytes(
  signedAt: string,
  entries: readonly CatalogEntry[],
  publisherKeyId: string,
): Uint8Array {
  return new TextEncoder().encode(
    canonicalJson({ signedAt, entries, publisherKeyId }),
  );
}

/**
 * Verify a catalog's Ed25519 signature against a trust key — the composition
 * of {@link catalogSignedBytes} and {@link verifyBundle} that every consumer
 * needs and none should assemble itself.
 *
 * Returns a boolean rather than throwing: callers own the diagnosis, and their
 * messages differ deliberately.
 */
export async function verifyCatalogSignature(
  catalog: SignedCatalog,
  trustKey: Uint8Array,
): Promise<boolean> {
  return verifyBundle(
    catalogSignedBytes(catalog.signedAt, catalog.entries, catalog.publisherKeyId),
    catalog.signature,
    trustKey,
  );
}

/**
 * Whether a parsed JSON value carries the four fields a catalog signature is
 * computed over. A shape check, not a trust check — it says the document can
 * be verified, never that it has been.
 *
 * Shared so the *field set* has one definition: adding a field to the signed
 * payload must be a single edit, since missing it in one verifier would mean
 * signing over bytes that verifier never reconstructs.
 */
export function isWellFormedCatalog(value: unknown): value is SignedCatalog {
  const c = value as SignedCatalog | null;
  return (
    c !== null &&
    typeof c === 'object' &&
    typeof c.signedAt === 'string' &&
    Array.isArray(c.entries) &&
    typeof c.publisherKeyId === 'string' &&
    typeof c.signature === 'string'
  );
}

// ── Encoding helpers ──────────────────────────────────────────────────

/** Standard-alphabet base64 (not base64url) to raw bytes. Throws on invalid input. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Raw bytes to standard-alphabet base64 (not base64url). */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/**
 * Copy a view into a standalone `ArrayBuffer`. WebCrypto rejects a
 * `SharedArrayBuffer`-backed view, and a subarray would otherwise hand it the
 * whole underlying buffer rather than the intended window.
 */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(view.byteLength);
  new Uint8Array(buf).set(view);
  return buf;
}
