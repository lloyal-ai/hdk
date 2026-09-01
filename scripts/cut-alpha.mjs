#!/usr/bin/env node
/**
 * Cut an alpha SET for this repo's arc branch.
 *
 * Only the packages the arc touched get alpha versions — untouched siblings
 * keep their published stables, and the release loop's npm-view guard skips
 * them. Each cut package's base is `bump(latest-on-the-registry)`, so a
 * stable that ships mid-arc self-corrects at the next cut; the `-alpha.N`
 * suffix is the SET id, shared across every package in the cut.
 *
 * Versions and exact internal pins are COMMITTED on the arc branch: the set
 * is recorded in git, the workspace still resolves locally for dev, and the
 * merge back to main resolves them to the real stable bump.
 *
 * Run locally: node scripts/cut-alpha.mjs --cut 0 [--dry-run]
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';

const cutIdx = process.argv.indexOf('--cut');
if (cutIdx === -1) throw new Error('required: --cut <N>');
const CUT = Number(process.argv[cutIdx + 1]);
const DRY = process.argv.includes('--dry-run');

/** What this arc touched → how far its next version moves. agents is a
 *  MAJOR: the arc removed 18 public exports (the content vocabulary moved
 *  to @lloyal-labs/media). */
const CUTS = {
  'packages/media': 'minor',
  'packages/sdk': 'minor',
  'packages/agents': 'major',
  'packages/rig': 'minor',
  'packages/dev-tools': 'minor',
};
/** Cross-repo deps that are ALSO being cut this arc (rig depends on the
 *  binding). Must match lloyal.node's own cut level. */
const EXTERNAL = { '@lloyal-labs/lloyal.node': 'minor' };

const bump = (v, level) => {
  const [maj, min] = v.split('.').map(Number);
  return level === 'major' ? `${maj + 1}.0.0` : `${maj}.${min + 1}.0`;
};
/** A prerelease `latest` (a manual first alpha publish stamps latest — npm
 *  behavior) is not a base to bump FROM: the stable it prefigures hasn't
 *  shipped, so its release triple IS the pending base. A stable latest
 *  bumps by the arc's level. */
const nextBase = (reg, level) => (reg.includes('-') ? reg.split('-')[0] : bump(reg, level));
/** Registry base, or the local manifest's for a package npm has never seen.
 *  NOTE: npm cannot CREATE a package name from CI (interactive 2FA) — a
 *  brand-new package (media, on this arc) needs ONE manual `npm publish`
 *  before the first cut's workflow run can succeed. */
const latest = (name, fallback) => {
  try {
    return execSync(`npm view ${name}@latest version`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    console.log(`  (${name} not on the registry yet — base ${fallback}, needs one manual first publish)`);
    return fallback;
  }
};

const alphas = {};
for (const [dir, level] of Object.entries(CUTS)) {
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
  const base = pkg.version.split('-')[0]; // a prior cut's -alpha.N is not a base
  alphas[pkg.name] = `${nextBase(latest(pkg.name, base), level)}-alpha.${CUT}`;
}
for (const [name, level] of Object.entries(EXTERNAL)) {
  alphas[name] = `${nextBase(latest(name, '0.0.0'), level)}-alpha.${CUT}`;
}

console.log(`cut ${CUT}${DRY ? ' (dry run)' : ''}:`);
for (const [n, v] of Object.entries(alphas)) console.log(`  ${n} -> ${v}`);

const dirs = ['packages', 'packages/abilities'].flatMap((root) =>
  readdirSync(root)
    .map((d) => `${root}/${d}`)
    .filter((d) => existsSync(`${d}/package.json`)),
);
for (const dir of dirs) {
  const path = `${dir}/package.json`;
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  let changed = false;
  if (dir in CUTS && pkg.version !== alphas[pkg.name]) {
    console.log(`  ${path}: version ${pkg.version} -> ${alphas[pkg.name]}`);
    pkg.version = alphas[pkg.name];
    changed = true;
  }
  for (const field of ['dependencies', 'peerDependencies']) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (alphas[dep] && pkg[field][dep] !== alphas[dep]) {
        console.log(`  ${path}: ${dep} ${pkg[field][dep]} -> ${alphas[dep]} (exact)`);
        pkg[field][dep] = alphas[dep];
        changed = true;
      }
    }
  }
  if (changed && !DRY) writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
}
