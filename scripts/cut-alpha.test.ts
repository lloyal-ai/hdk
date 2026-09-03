/**
 * The alpha cutter's pure core. The script is I/O around these: `npm view`
 * and file rewrites. Everything that can be wrong about a cut is decidable
 * here without a registry or a checkout.
 */
import { describe, it, expect } from 'vitest';
import { parseCut, latestVersion, planAlphas, rewriteManifest } from './cut-alpha.lib.mjs';

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
  it('is a golden: the set the templates pin today', () => {
    const registry: Record<string, string> = {
      '@lloyal-labs/sdk': '3.1.0', '@lloyal-labs/lloyal-agents': '5.5.1', '@lloyal-labs/rig': '5.5.0',
      '@lloyal-labs/dev-tools': '0.4.3', '@lloyal-labs/lloyal.node': '3.1.1',
    };
    const view = (name: string) => { if (name in registry) return registry[name]; throw e404; };
    const alphas = planAlphas({
      cut: 1,
      packages: [
        { name: '@lloyal-labs/media', level: 'minor', fallback: '0.1.0' },
        { name: '@lloyal-labs/sdk', level: 'minor', fallback: '0.0.0' },
        { name: '@lloyal-labs/lloyal-agents', level: 'major', fallback: '0.0.0' },
        { name: '@lloyal-labs/rig', level: 'minor', fallback: '0.0.0' },
        { name: '@lloyal-labs/dev-tools', level: 'minor', fallback: '0.0.0' },
        { name: '@lloyal-labs/lloyal.node', level: 'minor', fallback: '0.0.0' },
      ],
      view,
    });
    expect(alphas).toEqual({
      '@lloyal-labs/media': '0.2.0-alpha.1',
      '@lloyal-labs/sdk': '3.2.0-alpha.1',
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

  it('stamps a cut package: its version and its exact internal pins, deps and peers alike', () => {
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
    expect(pkg.peerDependencies['@lloyal-labs/lloyal-agents']).toBe('6.0.0-alpha.1');
  });

  it('a workspace member outside the cut keeps its version but its pins follow the set', () => {
    // The workspace must resolve as one set: an ability whose peer still named
    // -alpha.1 after cut 2 would fail the install. Its VERSION is not the
    // cutter's to move — abilities ship through the signed catalog, and their
    // release bumps it there.
    const pkg = {
      name: '@lloyal-labs/web-ability', version: '2.0.1',
      peerDependencies: { '@lloyal-labs/lloyal-agents': '6.0.0-alpha.0', effection: '^4' },  // the previous set
    };
    expect(rewriteManifest(pkg, { version: undefined, alphas })).toBe(true);
    expect(pkg.version).toBe('2.0.1');
    expect(pkg.peerDependencies['@lloyal-labs/lloyal-agents']).toBe(alphas['@lloyal-labs/lloyal-agents']);
    expect(pkg.peerDependencies.effection).toBe('^4');
  });
});
