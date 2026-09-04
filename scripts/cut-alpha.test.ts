/**
 * The alpha cutter's pure core. The script is I/O around these: `npm view`
 * and file rewrites. Everything that can be wrong about a cut is decidable
 * here without a registry or a checkout.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { satisfies } from 'semver';
import {
  CUTS, EXTERNAL, arcPackages, parseCut, latestVersion, planAlphas, rewriteManifest,
} from './cut-alpha.lib.mjs';

const e404 = Object.assign(new Error('npm ERR! code E404'), { stderr: 'npm ERR! code E404\nnpm ERR! 404 Not Found' });
const reset = Object.assign(new Error('npm ERR! code ECONNRESET'), { stderr: 'npm ERR! code ECONNRESET' });

describe('parseCut', () => {
  it('accepts a non-negative integer and nothing else', () => {
    expect(parseCut('2')).toBe(2);
    expect(parseCut('0')).toBe(0);
    for (const bad of [undefined, '', 'x', '-1', '1.5', 'NaN', '9'.repeat(400)]) {
      expect(() => parseCut(bad as string), String(bad).slice(0, 12)).toThrow(/--cut/);
    }
  });
});

describe('latestVersion', () => {
  it('falls back ONLY on a registry 404; every other failure aborts the cut', () => {
    expect(latestVersion('@x/new', '0.1.0', () => { throw e404; })).toBe('0.1.0');
    expect(() => latestVersion('@x/sdk', '3.1.0', () => { throw reset; })).toThrow(/ECONNRESET/);
    expect(latestVersion('@x/sdk', '3.1.0', () => '3.1.4\n')).toBe('3.1.4');
  });
});

describe('planAlphas', () => {
  it('is a golden over the REAL arc table: what cut 1 stamps from the registry as it stood', () => {
    // The table is imported, not copied: an earlier version of this test kept
    // its own list, said sdk was a minor while the script said major, and
    // stayed green while the cutter stamped 4.0.0. A golden that cannot see
    // the table it is a golden OF proves nothing.
    const registry: Record<string, string> = {
      '@lloyal-labs/sdk': '3.1.0', '@lloyal-labs/lloyal-agents': '5.5.1', '@lloyal-labs/rig': '5.5.0',
      '@lloyal-labs/dev-tools': '0.4.3', '@lloyal-labs/lloyal.node': '3.1.1',
    };
    const manifests: Record<string, { name: string; version: string }> = {
      'packages/media': { name: '@lloyal-labs/media', version: '0.1.0' },
      'packages/sdk': { name: '@lloyal-labs/sdk', version: '3.1.0' },
      'packages/agents': { name: '@lloyal-labs/lloyal-agents', version: '5.5.1' },
      'packages/rig': { name: '@lloyal-labs/rig', version: '5.5.0' },
      'packages/dev-tools': { name: '@lloyal-labs/dev-tools', version: '0.4.3' },
    };
    const view = (name: string) => { if (name in registry) return registry[name]; throw e404; };
    const alphas = planAlphas({
      cut: 1,
      packages: arcPackages(CUTS, EXTERNAL, (dir: string) => manifests[dir]),
      view,
    });
    expect(alphas).toEqual({
      '@lloyal-labs/media': '0.2.0-alpha.1',
      '@lloyal-labs/sdk': '4.0.0-alpha.1',
      '@lloyal-labs/lloyal-agents': '6.0.0-alpha.1',
      '@lloyal-labs/rig': '5.6.0-alpha.1',
      '@lloyal-labs/dev-tools': '0.5.0-alpha.1',
      '@lloyal-labs/lloyal.node': '3.2.0-alpha.1',
    });
  });

  it('a prerelease FALLBACK is the pending base too — a package not yet on the registry keeps its set', () => {
    // The manifest already says 0.2.0-alpha.1 after cut 1; a 404 at cut 2 must
    // continue 0.2.0-alpha.2, not treat 0.2.0 as a shipped stable and bump it.
    const alphas = planAlphas({
      cut: 2,
      packages: [{ name: '@lloyal-labs/media', level: 'minor', fallback: '0.2.0-alpha.1' }],
      view: () => { throw e404; },
    });
    expect(alphas['@lloyal-labs/media']).toBe('0.2.0-alpha.2');
  });

  it('a prerelease latest is the pending base, never bumped again', () => {
    const alphas = planAlphas({
      cut: 3,
      packages: [{ name: '@lloyal-labs/media', level: 'minor', fallback: '0.0.0' }],
      view: () => '0.2.0-alpha.0',
    });
    expect(alphas['@lloyal-labs/media']).toBe('0.2.0-alpha.3');
  });
});

describe('rewriteManifest', () => {
  const alphas = { '@lloyal-labs/sdk': '3.2.0-alpha.1', '@lloyal-labs/lloyal-agents': '6.0.0-alpha.1' };

  it('stamps a cut package: its version and its exact internal DEPENDENCIES; a range dependency becomes the pin', () => {
    // A dependency is a resolution instruction and a range excludes
    // prereleases, so `^3.1.0` on sdk would fail the install against the set;
    // it becomes the exact alpha. A range PEER is a compatibility statement and
    // is not the cutter's to rewrite (see below).
    const pkg = {
      name: '@lloyal-labs/rig', version: '5.5.0',
      dependencies: { '@lloyal-labs/sdk': '^3.1.0', effection: '^4' },
      peerDependencies: { '@lloyal-labs/lloyal-agents': '^5' },
    };
    const changed = rewriteManifest(pkg, { version: '5.6.0-alpha.1', alphas });
    expect(changed).toBe(true);
    expect(pkg.version).toBe('5.6.0-alpha.1');
    expect(pkg.dependencies['@lloyal-labs/sdk']).toBe('3.2.0-alpha.1');
    expect(pkg.dependencies.effection).toBe('^4');
    expect(pkg.peerDependencies['@lloyal-labs/lloyal-agents']).toBe('^5');
  });

  it('an EXACT peer from the previous set follows the new one (rig peers on the binding this way)', () => {
    const pkg = {
      name: '@lloyal-labs/rig', version: '5.6.0-alpha.0',
      peerDependencies: { '@lloyal-labs/lloyal.node': '3.2.0-alpha.0' },  // the previous set
    };
    const set = { ...alphas, '@lloyal-labs/lloyal.node': '3.2.0-alpha.1' };
    expect(rewriteManifest(pkg, { version: '5.6.0-alpha.1', alphas: set })).toBe(true);
    expect(pkg.peerDependencies['@lloyal-labs/lloyal.node']).toBe('3.2.0-alpha.1');
  });

  it('a devDependency on a set member follows the set too — the workspace must test against ITS binding', () => {
    // sdk and host develop against the binding through a devDependency. A
    // range there (`^3.1.1`) resolves to the published stable, so a fresh
    // workspace install tested the arc against the OLD binding — hidden all
    // arc by the symlink to the lloyal-node checkout.
    const pkg = {
      name: '@lloyal-labs/sdk', version: '4.0.0-alpha.1',
      devDependencies: { '@lloyal-labs/lloyal.node': '^3.1.1', vitest: '^4' },
    };
    const set = { ...alphas, '@lloyal-labs/lloyal.node': '3.2.0-alpha.1' };
    expect(rewriteManifest(pkg, { version: '4.0.0-alpha.1', alphas: set })).toBe(true);
    expect(pkg.devDependencies['@lloyal-labs/lloyal.node']).toBe('3.2.0-alpha.1');
    expect(pkg.devDependencies.vitest).toBe('^4');
  });

  it('a RANGE peer is authored compatibility and is left alone', () => {
    // An ability ships through the signed catalog to stable AND alpha users
    // alike, so its peer is a range that admits both — not the set's exact
    // pin, which the cutter must therefore not write over it.
    const range = '^5.0.0 || >=6.0.0-0 <7.0.0';
    const pkg = {
      name: '@lloyal-labs/web-ability', version: '2.0.2',
      peerDependencies: { '@lloyal-labs/lloyal-agents': range, effection: '^4' },
    };
    expect(rewriteManifest(pkg, { version: undefined, alphas })).toBe(false);
    expect(pkg.peerDependencies['@lloyal-labs/lloyal-agents']).toBe(range);
  });
});

describe('the abilities admit the set', () => {
  // The install that fails on this is the front door: `lloyal new` vendors an
  // ability from the catalog and npm checks its peers against the scaffold's
  // exact alpha pins. A range admits a prerelease only when one comparator
  // names that exact major.minor.patch with a prerelease tag — so `>=5 <7`
  // rejects 6.0.0-alpha.2 and `>=6.0.0-0` is what admits it. Checked with the
  // semver library npm itself resolves with.
  const ROOT = join(__dirname, '..');
  const manifestOf = (dir: string) =>
    JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as {
      name: string; version: string; peerDependencies?: Record<string, string>;
    };

  it('every ability peer on a set member admits the version the NEXT cut stamps, and the stable before it', () => {
    const registry: Record<string, string> = {
      '@lloyal-labs/sdk': '3.1.0', '@lloyal-labs/lloyal-agents': '5.5.1', '@lloyal-labs/rig': '5.5.0',
      '@lloyal-labs/dev-tools': '0.4.3', '@lloyal-labs/lloyal.node': '3.1.1',
    };
    const view = (name: string) => { if (name in registry) return registry[name]; throw e404; };
    const stamped = planAlphas({ cut: 99, packages: arcPackages(CUTS, EXTERNAL, manifestOf), view });
    for (const dir of ['packages/abilities/web', 'packages/abilities/corpus', 'packages/abilities/wikipedia']) {
      const peers = manifestOf(dir).peerDependencies ?? {};
      for (const [name, range] of Object.entries(peers)) {
        if (!(name in stamped)) continue;
        expect(satisfies(stamped[name], range), `${dir}: ${name} ${range} admits ${stamped[name]}`).toBe(true);
        expect(satisfies(registry[name], range), `${dir}: ${name} ${range} admits stable ${registry[name]}`).toBe(true);
      }
    }
  });

  it('the trap is real: a plain range excludes the prerelease, the -0 comparator admits it', () => {
    expect(satisfies('6.0.0-alpha.2', '>=5.0.0 <7.0.0')).toBe(false);
    expect(satisfies('6.0.0-alpha.2', '^5.0.0 || >=6.0.0-0 <7.0.0')).toBe(true);
    expect(satisfies('5.5.1', '^5.0.0 || >=6.0.0-0 <7.0.0')).toBe(true);
    expect(satisfies('7.0.0-alpha.1', '^5.0.0 || >=6.0.0-0 <7.0.0')).toBe(false);
  });
});
