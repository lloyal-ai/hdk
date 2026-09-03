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
 * merge back to main resolves them to the real stable bump. The lockfile is
 * regenerated to match — a lockfile describing the previous set makes a
 * frozen install refuse. That step needs every external pin published
 * (lloyal.node's alpha first); until then it reports and leaves the old
 * lockfile in place.
 *
 * The pure core (parseCut, planAlphas, rewriteManifest) lives in
 * cut-alpha.lib.mjs and is tested there.
 *
 * Run locally: node scripts/cut-alpha.mjs --cut 0 [--dry-run]
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { parseCut, planAlphas, rewriteManifest } from './cut-alpha.lib.mjs';

const cutIdx = process.argv.indexOf('--cut');
const CUT = parseCut(cutIdx === -1 ? undefined : process.argv[cutIdx + 1]);
const DRY = process.argv.includes('--dry-run');

/** What this arc touched → how far its next version moves. agents is a
 *  MAJOR: the arc removed 18 public exports (the content vocabulary moved
 *  to @lloyal-labs/media). sdk is a MAJOR: SessionContext gained required
 *  members (tokenToBytes, supportsVision/Audio, the multimodal natives) and
 *  decodeRcOf became decodeErrorOf — a third-party context stops
 *  type-checking, so this is not a minor. */
const CUTS = {
  'packages/media': 'minor',
  'packages/sdk': 'major',
  'packages/agents': 'major',
  'packages/rig': 'minor',
  'packages/dev-tools': 'minor',
};
/** Cross-repo deps that are ALSO being cut this arc (rig depends on the
 *  binding). Must match lloyal.node's own cut level. */
const EXTERNAL = { '@lloyal-labs/lloyal.node': 'minor' };

const view = (name) =>
  execSync(`npm view ${name}@latest version`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

const manifestOf = (dir) => JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
const cutPackages = Object.entries(CUTS).map(([dir, level]) => {
  const pkg = manifestOf(dir);
  // A prior cut's -alpha.N is not a base; the manifest's release triple is.
  return { dir, name: pkg.name, level, fallback: pkg.version.split('-')[0] };
});
const alphas = planAlphas({
  cut: CUT,
  packages: [
    ...cutPackages.map(({ name, level, fallback }) => ({ name, level, fallback })),
    ...Object.entries(EXTERNAL).map(([name, level]) => ({ name, level, fallback: '0.0.0' })),
  ],
  view,
});

console.log(`cut ${CUT}${DRY ? ' (dry run)' : ''}:`);
for (const [n, v] of Object.entries(alphas)) console.log(`  ${n} -> ${v}`);

// Only the cut packages are rewritten. Abilities keep their published
// versions and their peer ranges; the peer-range change they need ships as
// their own release.
const nameOf = Object.fromEntries(cutPackages.map((p) => [p.dir, p.name]));
for (const dir of readdirSync('packages').map((d) => `packages/${d}`).filter((d) => d in CUTS && existsSync(`${d}/package.json`))) {
  const path = `${dir}/package.json`;
  const pkg = manifestOf(dir);
  const before = JSON.stringify(pkg);
  if (rewriteManifest(pkg, { version: alphas[nameOf[dir]], alphas })) {
    console.log(`  ${path}: ${JSON.parse(before).version} -> ${pkg.version}, pins exact`);
    if (!DRY) writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  }
}

if (!DRY) {
  try {
    execSync('npm install --package-lock-only --ignore-scripts --no-audit --no-fund', { stdio: 'inherit' });
    console.log('  package-lock.json regenerated for the set');
  } catch {
    console.log('  package-lock.json NOT regenerated: an external pin is not published yet '
      + '(lloyal.node alpha first). Re-run `npm install --package-lock-only` once it is, and commit the lockfile with the pins.');
  }
}
