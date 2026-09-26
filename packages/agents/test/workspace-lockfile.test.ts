/**
 * The committed lockfile must describe the committed manifests. The alpha
 * cutter rewrites versions and exact pins across the workspace; a lockfile
 * that still records the previous set makes a frozen install (`npm ci`)
 * refuse — or install something other than what the manifests say.
 *
 * Anchored in the agents package because its entry is the one that drifts
 * first (a MAJOR on this arc), but the check is workspace-wide.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { satisfies } from 'semver';
import { CUTS } from '../../../scripts/cut-alpha.lib.mjs';

const ROOT = join(__dirname, '..', '..', '..');
/** The cutter's own table, imported and never copied. A second list here would go on checking the packages
 *  it was written with while the cutter moved a different set — silently, since a stale copy still passes. */
const CUT = Object.keys(CUTS);

describe('workspace lockfile', () => {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { version?: string }>;
  };

  it('records every cut package at the version its manifest declares', () => {
    for (const dir of CUT) {
      const manifest = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as { version: string };
      expect(lock.packages[dir]?.version, dir).toBe(manifest.version);
    }
  });

  it('records every platform package the binding declares — the lockfile is written on one OS and installed on all', () => {
    // npm resolves an optional platform package for every OS when it writes the
    // lockfile, and `npm install` on any OS then takes only what the lockfile
    // records. This one was written on darwin-arm64 at a moment linux-x64 and
    // darwin-x64 had not reached the registry, and "up to date" preserved the
    // hole for six cuts: every Linux install of the workspace had no binary,
    // which CI never said because CI never ran on the arc.
    const binding = lock.packages['node_modules/@lloyal-labs/lloyal.node'] as {
      version?: string; optionalDependencies?: Record<string, string>;
    };
    const platforms = Object.entries(binding.optionalDependencies ?? {});
    expect(platforms.length).toBeGreaterThan(0);
    for (const [name, version] of platforms) {
      expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(version);
    }
  });

  it('resolved the binding rig pins, not a stable a devDependency range let in', () => {
    // The workspace's binding is what rig's peer names. Under an alpha cut the
    // peer is an exact prerelease and this is equality; on a stable it is a
    // caret at the release floor, and the resolved binding must fall inside it.
    // sdk and host used to develop against `^3.1.1`, which resolved to the
    // published stable — so the workspace tested the arc against the old
    // binding while the symlink hid it.
    const rig = JSON.parse(readFileSync(join(ROOT, 'packages/rig/package.json'), 'utf8')) as {
      peerDependencies: Record<string, string>;
    };
    const peer = rig.peerDependencies['@lloyal-labs/lloyal.node'];
    const resolved = lock.packages['node_modules/@lloyal-labs/lloyal.node']?.version ?? '';
    expect(satisfies(resolved, peer), `lockfile ${resolved} vs rig's peer ${peer}`).toBe(true);
  });
});
