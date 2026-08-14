/**
 * The install path's catalog + manifest verification — the CLI-specific half.
 *
 * The signature machinery is NOT here. Canonical-JSON, Ed25519, the trust
 * roots and the signed shapes all live in `@lloyal-labs/channel-verify`, an
 * Apache-2.0 package with zero runtime dependencies and no native binary. That
 * last property is why it exists: importing `@lloyal-labs/rig` would pull the
 * App runtime and chain-import `lloyal-agents` → `sdk` → the native
 * `lloyal.node`, and a CLI that scaffolds projects must not require a native
 * binary on the user's platform. This file used to carry a hand-duplicated
 * copy of rig's verify surface for exactly that reason.
 *
 * What remains here is what the shared package deliberately does not own:
 *
 * - **Fetching.** `fetchAndVerifyCatalog` / `fetchAndVerifyManifest` are
 *   `async`/`await` over `http.ts`, whose headers-only deadline is tuned for
 *   the CLI's multi-gigabyte `.gguf` pulls. rig's equivalents are Effection
 *   `Operation`s with a memoizing cache. Same trust chain, different runtimes.
 * - **Error prose.** rig explains that the framework refuses to trust keys it
 *   does not vendor; these messages are terse. `verifyCatalogSignature`
 *   returns a boolean precisely so each caller keeps its own wording.
 * - **Version resolution.** `resolveAppVersion` and the semver matcher below
 *   are hand-rolled to keep this package dependency-free. rig uses node-semver
 *   and the two genuinely disagree — on `'*'` against a prerelease, and on
 *   `'>=1.0.0'`, which rig accepts and this rejects. Both behaviours are
 *   asserted by tests. Merging them would change which version of an app
 *   installs, so they stay apart until that is decided on purpose.
 *
 * The shape check and the signed-bytes assembly come from the shared package
 * (`isWellFormedCatalog`, `verifyCatalogSignature`) so the SIGNED FIELD SET has
 * exactly one definition. Re-deriving it here would let this file drift from
 * what the platform actually signs.
 */
import { httpFetch } from './http.js';
import {
  CHANNEL_CATALOG_URL,
  CHANNEL_TRUST_ROOTS,
  verifyBundle,
  sha512Integrity,
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

// ── Channel constants, schemas, errors ────────────────────────────────

/**
 * Re-exported from `@lloyal-labs/channel-verify`, which owns the one copy of
 * the trust roots, the catalog URL and the signed shapes.
 *
 * The platform key in particular used to be a verbatim byte-array literal in
 * both this file and rig, while the rotation runbook named only rig — so a
 * rotation carried out exactly as written would have left this CLI unable to
 * verify the rotated catalog. One copy removes that failure mode.
 */
export {
  CHANNEL_CATALOG_URL,
  CHANNEL_TRUST_ROOTS,
  BundleVerificationError,
  AppNotFoundError,
};
export type {
  AppBundleManifest,
  CatalogVersion,
  CatalogEntryMetadata,
  CatalogEntry,
  SignedCatalog,
};

// ── Verification primitives ───────────────────────────────────────────

/**
 * The Ed25519 primitive, the npm-compatible integrity digest, and the
 * canonical-JSON encoding that defines the catalog signature. Re-exported so
 * `vendor-app.ts` and the commands keep importing them from here.
 *
 * These were duplicated from `@lloyal-labs/rig` because rig's entry
 * chain-imports the App runtime and the native `@lloyal-labs/lloyal.node`, and
 * a CLI that scaffolds projects must not require a native binary on the user's
 * platform. `@lloyal-labs/channel-verify` is that same surface with no native
 * dependency and no runtime dependency at all, so the reason for the copy is
 * gone rather than merely the copy.
 */
export {
  verifyBundle,
  sha512Integrity,
  canonicalJson,
  catalogSignedBytes,
};

/**
 * Fetch the catalog from `CHANNEL_CATALOG_URL` and Ed25519-verify it
 * against the vendored trust roots. Throws `BundleVerificationError` on
 * any failure.
 */
export async function fetchAndVerifyCatalog(): Promise<SignedCatalog> {
  const url = CHANNEL_CATALOG_URL;
  const response = await httpFetch(url);
  if (!response.ok) {
    throw new BundleVerificationError(
      `Catalog fetch from ${url} returned HTTP ${response.status} ${response.statusText}.`,
    );
  }
  const text = await response.text();

  let catalog: SignedCatalog;
  try {
    catalog = JSON.parse(text) as SignedCatalog;
  } catch (err) {
    throw new BundleVerificationError(
      `Catalog at ${url} is not valid JSON: ${asMessage(err)}`,
    );
  }

  // Shape and signature checks come from channel-verify so the SIGNED FIELD
  // SET has one definition — adding a field to the payload must be one edit,
  // since missing it here would mean verifying over bytes this file never
  // reconstructs. The wording below stays the CLI's own.
  if (!isWellFormedCatalog(catalog)) {
    throw new BundleVerificationError(
      `Catalog at ${url} is malformed: it must carry signedAt, entries, ` +
        `publisherKeyId and signature, and every entry must have a name and ` +
        `a versions list of fully-formed version records.`,
    );
  }

  const trustKey = CHANNEL_TRUST_ROOTS.get(catalog.publisherKeyId);
  if (!trustKey) {
    throw new BundleVerificationError(
      `Catalog at ${url} is signed by publisherKeyId="${catalog.publisherKeyId}" ` +
        `which is not a vendored trust root.`,
    );
  }

  const ok = await verifyCatalogSignature(catalog, trustKey);
  if (!ok) {
    throw new BundleVerificationError(
      `Catalog at ${url} failed Ed25519 signature verification ` +
        `(publisherKeyId="${catalog.publisherKeyId}").`,
    );
  }

  return catalog;
}

/**
 * Resolve a name + optional semver range against a verified catalog to
 * a specific {@link CatalogVersion}. Picks the highest matching version
 * (semver-rcompare order). Throws {@link AppNotFoundError} if the name
 * is absent or no version matches the range.
 *
 * Pure: doesn't fetch — caller passes the verified catalog.
 */
export function resolveAppVersion(
  catalog: SignedCatalog,
  name: string,
  opts: { semver?: string } = {},
): CatalogVersion {
  const entry = catalog.entries.find((e) => e.name === name);
  if (!entry) {
    throw new AppNotFoundError(
      `App "${name}" is not listed in the catalog at ${CHANNEL_CATALOG_URL}.`,
    );
  }
  const range = opts.semver;
  const matching = range
    ? entry.versions.filter((v) => semverSatisfies(v.version, range))
    : [...entry.versions];
  if (matching.length === 0) {
    const available = entry.versions.map((v) => v.version).join(', ') || '(none published)';
    throw new AppNotFoundError(
      `App "${name}" has no version matching "${range ?? '*'}". ` +
        `Published versions: ${available}.`,
    );
  }
  matching.sort((a, b) => semverRcompare(a.version, b.version));
  return matching[0];
}

/**
 * Fetch a tarball manifest and cross-check against its catalog entry,
 * then return the validated `AppBundleManifest`. Does NOT verify the
 * tarball itself — caller fetches the tarball bytes and calls
 * `verifyBundle(bytes, manifest.signature, trustKey)` separately.
 */
export async function fetchAndVerifyManifest(
  entry: CatalogVersion,
  name: string,
): Promise<{ manifest: AppBundleManifest; trustKey: Uint8Array }> {
  const response = await httpFetch(entry.manifestUrl);
  if (!response.ok) {
    throw new BundleVerificationError(
      `Manifest fetch from ${entry.manifestUrl} returned HTTP ${response.status} ${response.statusText}.`,
    );
  }
  const text = await response.text();
  let manifest: AppBundleManifest;
  try {
    manifest = JSON.parse(text) as AppBundleManifest;
  } catch (err) {
    throw new BundleVerificationError(
      `Manifest at ${entry.manifestUrl} is not valid JSON: ${asMessage(err)}`,
    );
  }
  if (manifest.name !== name) {
    throw new BundleVerificationError(
      `Manifest name "${manifest.name}" does not match requested "${name}" ` +
        `(catalog manifestUrl=${entry.manifestUrl}).`,
    );
  }
  if (manifest.version !== entry.version) {
    throw new BundleVerificationError(
      `Manifest version "${manifest.version}" does not match catalog entry version "${entry.version}".`,
    );
  }
  if (manifest.sizeBytes !== entry.sizeBytes) {
    throw new BundleVerificationError(
      `Manifest sizeBytes ${manifest.sizeBytes} does not match catalog entry sizeBytes ${entry.sizeBytes}.`,
    );
  }
  const trustKey = CHANNEL_TRUST_ROOTS.get(manifest.publisherKeyId);
  if (!trustKey) {
    throw new BundleVerificationError(
      `Manifest publisherKeyId="${manifest.publisherKeyId}" is not a vendored trust root.`,
    );
  }
  return { manifest, trustKey };
}

// ── Minimal semver — only the operations the install CLI needs ────────

/**
 * Semver compare in *reverse* (newest-first). Lifted from `semver` to
 * avoid the npm package as a runtime dep.
 *
 * Only handles plain `X.Y.Z` and `X.Y.Z-prerelease`. Build metadata after
 * `+` is ignored. Pre-release ordering is lexicographic component-wise
 * (numeric components compare numerically).
 */
function semverRcompare(a: string, b: string): number {
  return semverCompare(b, a);
}

function semverCompare(a: string, b: string): number {
  const [aCore, aPre] = splitSemver(a);
  const [bCore, bPre] = splitSemver(b);
  for (let i = 0; i < 3; i++) {
    if (aCore[i] !== bCore[i]) return aCore[i] - bCore[i];
  }
  // pre-release < no pre-release (a release version outranks a prerelease)
  if (!aPre && bPre) return 1;
  if (aPre && !bPre) return -1;
  if (!aPre && !bPre) return 0;
  return comparePrerelease(aPre as string, bPre as string);
}

function splitSemver(v: string): [number[], string | null] {
  const stripped = v.split('+')[0]; // ignore build metadata
  const dashIdx = stripped.indexOf('-');
  const core = dashIdx === -1 ? stripped : stripped.slice(0, dashIdx);
  const pre = dashIdx === -1 ? null : stripped.slice(dashIdx + 1);
  const parts = core.split('.').map((p) => Number(p));
  if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p))) {
    throw new Error(`invalid semver: ${v}`);
  }
  return [parts, pre];
}

function comparePrerelease(a: string, b: string): number {
  const aParts = a.split('.');
  const bParts = b.split('.');
  const max = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < max; i++) {
    if (i >= aParts.length) return -1;
    if (i >= bParts.length) return 1;
    const ax = aParts[i];
    const bx = bParts[i];
    const aNum = /^\d+$/.test(ax);
    const bNum = /^\d+$/.test(bx);
    if (aNum && bNum) {
      const diff = Number(ax) - Number(bx);
      if (diff !== 0) return diff;
    } else if (aNum) {
      return -1; // numeric < non-numeric
    } else if (bNum) {
      return 1;
    } else {
      if (ax !== bx) return ax < bx ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Check whether `version` satisfies `range`. Supports:
 * - exact: `1.2.3`
 * - caret: `^1.2.3` (≥ 1.2.3 < 2.0.0, with the npm convention that
 *   `^0.2.3` means ≥ 0.2.3 < 0.3.0 and `^0.0.3` means ≥ 0.0.3 < 0.0.4)
 * - tilde: `~1.2.3` (≥ 1.2.3 < 1.3.0)
 * - wildcard: `*` or empty (any version)
 *
 * Anything else throws. Plenty of npm semver syntax is unsupported
 * (`||`, `>=`, `<`, hyphen ranges) — the install CLI documents the
 * subset it accepts; if a consumer needs more, they pin to an exact
 * version.
 */
function semverSatisfies(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*') return true;

  if (trimmed.startsWith('^')) {
    const target = trimmed.slice(1);
    const [tParts] = splitSemver(target);
    const [vParts, vPre] = splitSemver(version);
    if (vPre && !equalCore(tParts, vParts)) return false;
    if (semverCompare(version, target) < 0) return false;
    // Upper bound: bump major (or minor if major===0, or patch if both ===0).
    if (tParts[0] > 0) return vParts[0] < tParts[0] + 1;
    if (tParts[1] > 0) return vParts[0] === 0 && vParts[1] < tParts[1] + 1;
    return vParts[0] === 0 && vParts[1] === 0 && vParts[2] < tParts[2] + 1;
  }

  if (trimmed.startsWith('~')) {
    const target = trimmed.slice(1);
    const [tParts] = splitSemver(target);
    const [vParts, vPre] = splitSemver(version);
    if (vPre && !equalCore(tParts, vParts)) return false;
    if (semverCompare(version, target) < 0) return false;
    return vParts[0] === tParts[0] && vParts[1] === tParts[1];
  }

  // Exact match
  try {
    const [tParts, tPre] = splitSemver(trimmed);
    const [vParts, vPre] = splitSemver(version);
    return equalCore(tParts, vParts) && tPre === vPre;
  } catch {
    throw new Error(
      `unsupported semver range "${range}" — use exact version, ^prefix, ~prefix, or *`,
    );
  }
}

function equalCore(a: number[], b: number[]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
