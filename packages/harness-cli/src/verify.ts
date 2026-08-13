/**
 * Channel verification primitives for `harness.dev install`.
 *
 * This file duplicates the verify-only surface of `@lloyal-labs/rig`'s
 * `bundle.ts` + `protocol.ts` — the catalog/manifest/tarball Ed25519
 * verification chain, the canonical-JSON encoder used to compute the
 * catalog's signed payload, and the framework-vendored
 * `CHANNEL_TRUST_ROOTS` + `CHANNEL_CATALOG_URL` constants.
 *
 * **Why duplicate.** `@lloyal-labs/rig`'s main entry pulls in the App
 * runtime surface (define-app, registry, spine-render, tools) which
 * chain-imports `@lloyal-labs/lloyal-agents` → `@lloyal-labs/sdk` →
 * native `@lloyal-labs/lloyal.node`. The install CLI needs none of
 * that — it's a pure JS catalog-verify-then-shell-out-to-npm flow. So
 * `harness.dev` ships zero runtime deps on the lloyal stack, and
 * `npm install -g harness.dev` does not require a native binary on
 * the user's platform.
 *
 * **Drift risk.** Three independent implementations of canonical-JSON
 * + Ed25519 verify exist (this file, `@lloyal-labs/rig/src/bundle.ts`,
 * and `lloyal-infra/hdk-workers/publish-worker/src/{crypto,catalog}.ts`).
 * Any divergence is caught immediately: the Worker signs once,
 * rig/harness-cli both must reproduce the exact signed bytes to verify,
 * and the on-the-wire signed catalog is the cross-check. Bytes-level
 * tests would belong here if the surface expands.
 *
 * The one import below is the sole exception to this file's otherwise
 * total self-containment: the catalog + manifest fetches are the FIRST
 * network calls on the vendoring path, so they are the ones that must
 * not hang. `http.ts` is original Apache-2.0 CLI code, so it carries no
 * FSL provenance into a future `@lloyal-labs/channel-verify` extraction
 * (task #465) — that package would take it along or accept a `fetch`.
 *
 * `http.ts` is in fact a SECOND instance of this file's own story: a rig
 * primitive (`rig/src/cancellable-fetch.ts`) re-authored here because the
 * native-dep chain makes importing it impossible. Same cause, same remedy
 * — #465 should extract both, not just the verify surface.
 */
import { httpFetch } from './http.js';
import {
  CHANNEL_CATALOG_URL,
  CHANNEL_TRUST_ROOTS,
  verifyBundle,
  sha512Integrity,
  canonicalJson,
  catalogSignedBytes,
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
 * against `CHANNEL_TRUST_ROOTS`. Throws `BundleVerificationError` on
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

  const trustKey = CHANNEL_TRUST_ROOTS.get(catalog.publisherKeyId);
  if (!trustKey) {
    throw new BundleVerificationError(
      `Catalog at ${url} is signed by publisherKeyId="${catalog.publisherKeyId}" ` +
        `which is not in CHANNEL_TRUST_ROOTS.`,
    );
  }

  const signedBytes = catalogSignedBytes(
    catalog.signedAt,
    catalog.entries,
    catalog.publisherKeyId,
  );
  const ok = await verifyBundle(signedBytes, catalog.signature, trustKey);
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
      `Manifest publisherKeyId="${manifest.publisherKeyId}" is not in CHANNEL_TRUST_ROOTS.`,
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
