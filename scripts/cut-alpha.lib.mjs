/**
 * The alpha cutter's pure core. `cut-alpha.mjs` is I/O around these — the
 * registry lookup and the manifest writes — so everything that can be wrong
 * about a cut is decidable here, and tested without a registry or a checkout.
 */

/** `--cut <N>`: a non-negative integer, nothing else. `Number()` would take
 *  a missing or garbled value as NaN and stamp `-alpha.NaN` everywhere. */
export function parseCut(arg) {
  const n = arg === undefined || !/^\d+$/.test(String(arg)) ? NaN : Number(arg);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`--cut <N> must be a non-negative integer (got ${JSON.stringify(arg ?? null)})`);
  }
  return n;
}

/** A prerelease `latest` (a manual first alpha publish stamps latest — npm
 *  behavior) is not a base to bump FROM: the stable it prefigures has not
 *  shipped, so its release triple IS the pending base. A stable latest bumps
 *  by the arc's level. */
export function nextBase(reg, level) {
  if (reg.includes('-')) return reg.split('-')[0];
  const [maj, min] = reg.split('.').map(Number);
  return level === 'major' ? `${maj + 1}.0.0` : `${maj}.${min + 1}.0`;
}

/** Is this `npm view` failure the registry saying "no such package"? Only
 *  that answer earns the local fallback — a transient network, auth or
 *  rate-limit failure must abort the cut, or stale bases get stamped as if
 *  they were the registry's word. */
export const isNotFound = (err) =>
  err?.code === 'E404' || /\bE404\b|404 Not Found/.test(`${err?.stderr ?? ''}\n${err?.message ?? ''}`);

/** The registry's latest for `name`, via `view(name)` (returns the version
 *  string, or throws npm's error). Falls back to `fallback` ONLY on 404. */
export function latestVersion(name, fallback, view) {
  try {
    return String(view(name)).trim();
  } catch (err) {
    if (!isNotFound(err)) throw err;
    console.log(`  (${name} not on the registry yet — base ${fallback}, needs one manual first publish)`);
    return fallback;
  }
}

/**
 * The set: `{ name → x.y.z-alpha.<cut> }` for every package in `packages`,
 * bases resolved through `view`.
 * @param {{ cut: number,
 *           packages: Array<{ name: string, level: 'major' | 'minor', fallback: string }>,
 *           view: (name: string) => string }} plan
 * @returns {Record<string, string>}
 */
export function planAlphas({ cut, packages, view }) {
  /** @type {Record<string, string>} */
  const alphas = {};
  for (const { name, level, fallback } of packages) {
    alphas[name] = `${nextBase(latestVersion(name, fallback, view), level)}-alpha.${cut}`;
  }
  return alphas;
}

/** Rewrite one manifest object in place: its `version` when this package is
 *  in the cut (`version` given), and every dependency/peer that names a cut
 *  package to the exact alpha — in EVERY workspace manifest, because the
 *  workspace must resolve as one set (a peer still naming the previous
 *  -alpha.N fails the install). A member outside the cut keeps its version:
 *  the npm loop skips already-published versions, and the abilities ship
 *  through the signed catalog, whose release moves theirs. Returns whether
 *  anything changed. */
export function rewriteManifest(pkg, { version, alphas }) {
  let changed = false;
  if (version !== undefined && pkg.version !== version) { pkg.version = version; changed = true; }
  for (const field of ['dependencies', 'peerDependencies']) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (alphas[dep] && pkg[field][dep] !== alphas[dep]) { pkg[field][dep] = alphas[dep]; changed = true; }
    }
  }
  return changed;
}
