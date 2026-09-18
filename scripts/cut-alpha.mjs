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
 * The pure core — the arc table, parseCut, planAlphas, rewriteManifest —
 * lives in cut-alpha.lib.mjs and is tested there.
 *
 * Run locally: node scripts/cut-alpha.mjs --cut 0 [--dry-run]
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { CUTS, EXTERNAL, arcPackages, parseCut, planAlphas, rewriteManifest, include, unclosed } from './cut-alpha.lib.mjs';

const cutIdx = process.argv.indexOf('--cut');
const CUT = parseCut(cutIdx === -1 ? undefined : process.argv[cutIdx + 1]);
const DRY = process.argv.includes('--dry-run');
// `--include <name>`, repeatable and REQUIRED. Absence cuts nothing: the table
// says what the arc touched, never what ships today, and defaulting to all of
// it is what stamped a version for a member that shipped nothing.
const INCLUDE = process.argv.flatMap((a, i) => (a === '--include' ? [process.argv[i + 1]] : []));

const view = (name) =>
  execSync(`npm view ${name}@latest version`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

const manifestOf = (dir) => JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
const arc = arcPackages(CUTS, EXTERNAL, manifestOf);
const planned = planAlphas({ cut: CUT, packages: arc, view });
const alphas = include(planned, INCLUDE);

// A member left out keeps the pin it already carries, so every manifest that
// names it still resolves. A member left out that something IN the set depends
// on is a different thing: it never republishes, so the registry would hold a
// package whose manifest disagrees with git.
const gaps = unclosed(alphas, arc, manifestOf);
if (gaps.length > 0) {
  const lines = gaps.map((g) => `  ${g.dependent} depends on ${g.dep}, which is in the cut`);
  throw new Error(`--include is not dependency-closed:\n${lines.join('\n')}\nAdd them, or drop ${gaps[0].dep}.`);
}

console.log(`cut ${CUT}${DRY ? ' (dry run)' : ''}:`);
for (const [n, v] of Object.entries(alphas)) console.log(`  ${n} -> ${v}`);
for (const [n, v] of Object.entries(planned)) {
  if (!alphas[n]) console.log(`  ${n} HELD at its published pin (would have been ${v})`);
}

// Every workspace manifest follows the set's exact pins; only a cut package's
// version moves. The abilities are members too (their peers name the set) but
// ship through the signed catalog, not this repo's npm loop — their release
// bumps their versions there.
const nameOf = Object.fromEntries(arc.filter((p) => p.dir).map((p) => [p.dir, p.name]));
const dirs = ['packages', 'packages/abilities'].flatMap((root) =>
  readdirSync(root).map((d) => `${root}/${d}`).filter((d) => existsSync(`${d}/package.json`)));
for (const dir of dirs) {
  const path = `${dir}/package.json`;
  const pkg = manifestOf(dir);
  const before = JSON.parse(JSON.stringify(pkg));
  if (rewriteManifest(pkg, { version: dir in CUTS ? alphas[nameOf[dir]] : undefined, alphas })) {
    console.log(`  ${path}: ${before.version} -> ${pkg.version}, pins exact`);
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
