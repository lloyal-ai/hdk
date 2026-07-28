/**
 * The `harnessdev` provenance marker in a scaffolded project's `package.json`.
 *
 * `{ template, targets }` records the ONE un-derivable fact `targets:add` needs
 * — which template's target subtree to copy back — plus the surfaces present.
 * The filesystem `targets/<t>/` dirs stay the runtime truth; this marker is the
 * declared record, stamped by `new` and kept in sync by the `targets:` verbs
 * (they already rewrite `package.json`). npm ignores the extra top-level key.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Target } from './prune-targets.js';

export interface ProjectMarker {
  /** Template this project was scaffolded from (`blank` | `research`). */
  template: string;
  /** Run surfaces present, kept in sync by `targets:add`/`targets:remove`. */
  targets: Target[];
}

/** Stamp `harnessdev: { template, targets }` into `<projectDir>/package.json`. */
export function writeProjectMarker(projectDir: string, marker: ProjectMarker): void {
  const pkg = readPkg(projectDir);
  pkg.harnessdev = { template: marker.template, targets: marker.targets };
  writePkg(projectDir, pkg);
}

/** Read the marker, or `null` if absent/malformed (pre-marker / hand-made project). */
export function readProjectMarker(projectDir: string): ProjectMarker | null {
  let pkg: PkgWithMarker;
  try {
    pkg = readPkg(projectDir);
  } catch {
    return null;
  }
  const m = pkg.harnessdev;
  if (!m || typeof m.template !== 'string' || !Array.isArray(m.targets)) return null;
  return { template: m.template, targets: m.targets as Target[] };
}

/**
 * Rewrite just `harnessdev.targets` (after a `targets:` verb changes the set),
 * preserving the recorded `template`. A NO-OP when no marker exists — we never
 * fabricate a `template` (that is the one fact `targets:add` relies on; a guess
 * would later copy surfaces from the wrong template). `targets:add` requires the
 * marker up front, so only `targets:remove` on a pre-marker project hits this.
 */
export function setMarkerTargets(projectDir: string, targets: Target[]): void {
  const pkg = readPkg(projectDir);
  if (!pkg.harnessdev || typeof pkg.harnessdev.template !== 'string') return;
  pkg.harnessdev = { template: pkg.harnessdev.template, targets };
  writePkg(projectDir, pkg);
}

interface PkgWithMarker {
  harnessdev?: { template?: unknown; targets?: unknown };
  [k: string]: unknown;
}

function readPkg(projectDir: string): PkgWithMarker {
  return JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as PkgWithMarker;
}

function writePkg(projectDir: string, pkg: PkgWithMarker): void {
  writeFileSync(join(projectDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
}
