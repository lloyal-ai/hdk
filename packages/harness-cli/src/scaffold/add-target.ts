/**
 * Add a run surface back to a scaffolded project — the exact inverse of
 * `pruneTargets`. It re-materializes what prune removed for a target: the
 * `targets/<t>/` dir + the target's exclusive files, its npm scripts + deps
 * (VERSIONS sourced from the originating template's `package.json`), and its
 * slice of the tsconfig split. The template is read from the `harnessdev.template`
 * marker so a `web` surface added to a `research` project folds research's own
 * views — not blank's.
 *
 * Shares the per-target tables with `prune-targets.ts` (so add-copy ↔
 * prune-delete can't drift) and the JSONC array editing with `jsonc.ts`.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Target,
  type PrunableTarget,
  TARGET_SCRIPTS,
  TARGET_DEPS,
  TARGET_DEV_DEPS,
  TARGET_FILES,
  SHARED_RENDERER_DEPS,
  SHARED_RENDERER_DEV_DEPS,
  rewriteTargetsLine,
} from './prune-targets.js';
import {
  resolveTemplateDir,
  copyTreeWithSubstitutions,
  copyFileWithSubstitutions,
  buildSubstitutions,
} from './copy-tree.js';
import { filterJsoncArray, mergeJsoncArray, readJsoncArray } from './jsonc.js';

const ALL_TARGETS: Target[] = ['cli', 'desktop', 'web'];

/** The non-cli targets that currently have a scaffolded dir (cli always kept). */
export function presentTargets(projectDir: string): Target[] {
  const present = new Set<Target>(['cli']);
  for (const t of ['desktop', 'web'] as PrunableTarget[]) {
    if (existsSync(join(projectDir, 'targets', t))) present.add(t);
  }
  return ALL_TARGETS.filter((t) => present.has(t));
}

/**
 * Add `target` back to `projectDir`, copying from `template`. Returns the new
 * full target set (for the marker). Throws if the target is already present or
 * the template lacks it.
 */
export function addTarget(projectDir: string, target: PrunableTarget, template: string): Target[] {
  const before = new Set(presentTargets(projectDir));
  if (before.has(target)) {
    throw new Error(`target "${target}" is already present`);
  }
  const templateDir = resolveTemplateDir(template);
  const templateTargetDir = join(templateDir, 'targets', target);
  if (!existsSync(templateTargetDir)) {
    throw new Error(`template "${template}" has no targets/${target}/ to copy`);
  }

  const projectName = (readJson(join(projectDir, 'package.json')).name as string) ?? 'harness';
  const subs = buildSubstitutions(projectName);

  // 1. The target's own dir.
  copyTreeWithSubstitutions(templateTargetDir, join(projectDir, 'targets', target), subs);

  // 2. Its exclusive top-level files (bin shim / build config).
  for (const rel of TARGET_FILES[target]) {
    const src = join(templateDir, rel);
    if (existsSync(src)) copyFileWithSubstitutions(src, join(projectDir, rel), subs);
  }

  // Both `web` and `desktop` contribute DOM (React) sources to tsconfig.web.json.
  const domBefore = before.has('web') || before.has('desktop');
  const hasDesktopAfter = target === 'desktop' || before.has('desktop');

  // 3. package.json — restore scripts + deps (add-if-absent, versions from template).
  restorePackageJson(projectDir, templateDir, target, { domBefore, hasDesktopAfter });

  // 4. tsconfig split.
  restoreTsconfig(projectDir, templateDir, target, domBefore);

  // 5. harness.yml `targets:` line.
  const after = ALL_TARGETS.filter((t) => before.has(t) || t === target);
  rewriteTargetsLine(projectDir, after);
  return after;
}

interface PkgShape {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [k: string]: unknown;
}

function restorePackageJson(
  projectDir: string,
  templateDir: string,
  target: PrunableTarget,
  flags: { domBefore: boolean; hasDesktopAfter: boolean },
): void {
  const pkgPath = join(projectDir, 'package.json');
  const pkg = readJson(pkgPath);
  const tpl = readJson(join(templateDir, 'package.json'));
  pkg.scripts ??= {};
  pkg.dependencies ??= {};
  pkg.devDependencies ??= {};

  for (const s of TARGET_SCRIPTS[target]) {
    if (tpl.scripts?.[s] != null && pkg.scripts[s] == null) pkg.scripts[s] = tpl.scripts[s];
  }
  addFromTemplate(pkg.dependencies, tpl.dependencies, TARGET_DEPS[target]);
  addFromTemplate(pkg.devDependencies, tpl.devDependencies, TARGET_DEV_DEPS[target]);
  // The shared DOM-renderer deps come back only with the FIRST DOM target.
  if (!flags.domBefore) {
    addFromTemplate(pkg.dependencies, tpl.dependencies, SHARED_RENDERER_DEPS);
    addFromTemplate(pkg.devDependencies, tpl.devDependencies, SHARED_RENDERER_DEV_DEPS);
  }
  // Rebuild `typecheck` for the surviving tsconfigs (a DOM target now exists).
  if (pkg.scripts.typecheck != null) {
    const parts = ['tsc --noEmit', 'tsc -p tsconfig.web.json'];
    if (flags.hasDesktopAfter) parts.push('tsc -p tsconfig.electron.json');
    pkg.scripts.typecheck = parts.join(' && ');
  }
  writeJson(pkgPath, pkg);
}

/** Copy `keys` from `source` into `target`, add-if-absent (never clobber). */
function addFromTemplate(
  target: Record<string, string>,
  source: Record<string, string> | undefined,
  keys: readonly string[],
): void {
  if (!source) return;
  for (const k of keys) {
    if (source[k] != null && target[k] == null) target[k] = source[k];
  }
}

function restoreTsconfig(
  projectDir: string,
  templateDir: string,
  target: PrunableTarget,
  domBefore: boolean,
): void {
  const underTarget = (entry: string): boolean => entry.startsWith(`targets/${target}`);

  // Root tsconfig.json: merge this target's EXCLUDE entries (it always exists;
  // its `include` is a glob that already covers the new dir).
  const rootCfg = join(projectDir, 'tsconfig.json');
  if (existsSync(rootCfg)) {
    const excludeToAdd = readJsoncArray(join(templateDir, 'tsconfig.json'), 'exclude').filter(underTarget);
    mergeJsoncArray(rootCfg, 'exclude', excludeToAdd);
  }

  // tsconfig.web.json holds the DOM sources (web browser + Electron renderer).
  const webCfg = join(projectDir, 'tsconfig.web.json');
  if (domBefore) {
    // A DOM target already present → merge this target's include entries.
    const includeToAdd = readJsoncArray(join(templateDir, 'tsconfig.web.json'), 'include').filter(underTarget);
    mergeJsoncArray(webCfg, 'include', includeToAdd);
  } else {
    // cli-only → prune deleted tsconfig.web.json; restore from the template, then
    // keep only harness/* + THIS target's entries (drop the other DOM target's).
    copyFileWithSubstitutions(join(templateDir, 'tsconfig.web.json'), webCfg, {});
    filterJsoncArray(webCfg, 'include', (entry) => !entry.startsWith('targets/') || underTarget(entry));
  }
}

function readJson(p: string): PkgShape {
  return JSON.parse(readFileSync(p, 'utf8')) as PkgShape;
}

function writeJson(p: string, o: unknown): void {
  writeFileSync(p, `${JSON.stringify(o, null, 2)}\n`);
}
