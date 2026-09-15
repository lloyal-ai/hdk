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

  it('resolved the binding rig pins, not a stable a devDependency range let in', () => {
    // rig peers on the binding EXACTLY; sdk and host used to develop against
    // `^3.1.1`, which resolves to the published stable — so the workspace
    // tested the arc against the old binding while the symlink hid it.
    const rig = JSON.parse(readFileSync(join(ROOT, 'packages/rig/package.json'), 'utf8')) as {
      peerDependencies: Record<string, string>;
    };
    expect(lock.packages['node_modules/@lloyal-labs/lloyal.node']?.version)
      .toBe(rig.peerDependencies['@lloyal-labs/lloyal.node']);
  });
});
