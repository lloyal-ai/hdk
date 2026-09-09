/**
 * The alpha cutter's pure core. `cut-alpha.mjs` is I/O around these — the
 * registry lookup and the manifest writes — so everything that can be wrong
 * about a cut is decidable here, and tested without a registry or a checkout.
 */

/** What this arc touched → how far its next version moves. agents is a
 *  MAJOR: the arc removed 18 public exports (the content vocabulary moved
 *  to @lloyal-labs/media). sdk is a MAJOR: SessionContext gained required
 *  members (tokenToBytes, supportsVision/Audio, the multimodal natives) and
 *  decodeRcOf became decodeErrorOf — a third-party context stops
 *  type-checking, so this is not a minor.
 *
 *  Exported so the golden test reads THIS table rather than a copy of it: a
 *  copy once said sdk was a minor while this said major, and stayed green.
 *  @type {Record<string, 'major' | 'minor'>} */
export const CUTS = {
  'packages/media': 'minor',
  'packages/sdk': 'major',
  'packages/agents': 'major',
  'packages/rig': 'minor',
  'packages/dev-tools': 'minor',
};
/** Cross-repo deps that are ALSO being cut this arc (rig depends on the
 *  binding). Must match lloyal.node's own cut level.
 *  @type {Record<string, 'major' | 'minor'>} */
export const EXTERNAL = { '@lloyal-labs/lloyal.node': 'minor' };

/**
 * The cut's package list for `planAlphas`, from the tables and a manifest
 * reader. For a package the registry has never seen, the manifest IS the
 * base — a prior cut's -alpha.N is the pending release, continued, never
 * bumped again. Externals live in another repo, so they have no manifest
 * here and no local fallback.
 * @param {Record<string, 'major' | 'minor'>} cuts  dir → level
 * @param {Record<string, 'major' | 'minor'>} external  name → level
 * @param {(dir: string) => { name: string, version: string }} manifestOf
 * @returns {Array<{ dir?: string, name: string, level: 'major' | 'minor', fallback: string }>}
 */
export function arcPackages(cuts, external, manifestOf) {
  return [
    ...Object.entries(cuts).map(([dir, level]) => {
      const pkg = manifestOf(dir);
      return { dir, name: pkg.name, level, fallback: pkg.version };
    }),
    ...Object.entries(external).map(([name, level]) => ({ name, level, fallback: '0.0.0' })),
  ];
}

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

/** An exact version, as a prior cut stamps it — as opposed to a RANGE. */
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * The members this cut actually ships.
 *
 * The tables say what the arc TOUCHED; they cannot say what moves on any given
 * cut. Treating them as the set is what stamped `3.2.0-alpha.4` for a binding
 * that was not shipping, and pinned three manifests to a version that would
 * never exist.
 *
 * A whitelist rather than an exclusion, because the failure modes are not
 * symmetric. Forget to exclude and you stamp a phantom version. Forget to
 * include and the package keeps its published version, which every dependent
 * then pins — an incomplete set where everything still resolves. Omission has
 * to degrade, not break.
 *
 * Throws on a name the tables do not contain, and the caller must pass at
 * least one: a cut is a decision, and there is no sensible default for it.
 * Defaulting to the whole table is what stamped a version for a member that
 * shipped nothing, so absence has to mean nothing, never everything.
 */
export function include(alphas, names) {
  if (names.length === 0) {
    throw new Error(`--include <name> is required (one or more of: ${Object.keys(alphas).join(', ')})`);
  }
  const kept = {};
  for (const n of names) {
    if (!(n in alphas)) {
      throw new Error(`--include ${n}: not in the cut (${Object.keys(alphas).join(', ')})`);
    }
    kept[n] = alphas[n];
  }
  return kept;
}

/**
 * Cuttable packages left OUT of the set that depend on something IN it.
 *
 * Such a package has its pins rewritten to the new set but keeps its own
 * version, so the npm loop skips it as already-published and the registry ends
 * up holding a package whose manifest disagrees with git. The cut ships a
 * version nothing consumes.
 *
 * Only members of `CUTS` are considered. A workspace package outside the arc
 * (host, binding, relay, channel-verify) was never going to move, and its pins
 * following the set is the existing, intended behaviour.
 *
 * The predicate is {@link rewriteManifest}'s, deliberately: whatever that
 * function would REWRITE is what this must check, so the two cannot drift.
 * Peers count only when already exact, since a range peer is authored
 * compatibility and no cut writes over it.
 */
export function unclosed(alphas, packages, manifestOf) {
  const gaps = [];
  for (const p of packages) {
    if (!p.dir || alphas[p.name]) continue;
    const pkg = manifestOf(p.dir);
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const [dep, current] of Object.entries(pkg[field] ?? {})) {
        if (!alphas[dep]) continue;
        if (field === 'peerDependencies' && !EXACT.test(current)) continue;
        gaps.push({ dependent: p.name, dep });
      }
    }
  }
  return gaps;
}

/** Rewrite one manifest object in place: its `version` when this package is
 *  in the cut (`version` given); every DEPENDENCY and DEVDEPENDENCY that names
 *  a cut package to the exact alpha, in EVERY workspace manifest, because the
 *  workspace must resolve as one set and a range excludes prereleases (sdk
 *  and host develop against the binding through a devDependency — `^3.1.1`
 *  there resolved the published stable while the checkout symlink hid it);
 *  and a PEER only when it is already an exact pin from a previous set
 *  (rig's peer on the binding). A peer that is a range is authored compatibility and stays: an
 *  ability ships through the signed catalog to stable and alpha users alike,
 *  so its peer admits both (`^5.0.0 || >=6.0.0-0 <7.0.0`) and no cut may
 *  write the set's pin over it. A member outside the cut keeps its version:
 *  the npm loop skips already-published versions, and the catalog release
 *  moves an ability's. Returns whether anything changed. */
export function rewriteManifest(pkg, { version, alphas }) {
  let changed = false;
  if (version !== undefined && pkg.version !== version) { pkg.version = version; changed = true; }
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      const current = pkg[field][dep];
      if (!alphas[dep] || current === alphas[dep]) continue;
      if (field === 'peerDependencies' && !EXACT.test(current)) continue;
      pkg[field][dep] = alphas[dep];
      changed = true;
    }
  }
  return changed;
}
