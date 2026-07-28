/**
 * Prune a scaffolded harness project down to the selected run targets.
 *
 * `new` copies the FULL template (cli + desktop + web), then this removes the
 * surfaces the user didn't pick — their `targets/<t>/` dir, their bin shim,
 * their npm scripts + exclusive deps, and their slice of the tsconfig split — so
 * a "cli-only" project doesn't drag in electron/vite. `cli` is mandatory (it
 * carries the engine bin) and is never pruned.
 *
 * Edits are surgical: `package.json` is pure JSON (parse → delete keys →
 * re-stringify), while `harness.yml` + the tsconfig files are edited line-wise
 * so their guidance comments survive. The `targets:` field in `harness.yml` is
 * documentation (nothing reads it at runtime); what makes a target real is its
 * dir + scripts + deps, which is what we remove here.
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { filterJsoncArray } from './jsonc.js';

export type Target = 'cli' | 'desktop' | 'web';
export type PrunableTarget = Exclude<Target, 'cli'>;

/**
 * The single source of truth for what each non-cli target OWNS. `pruneTargets`
 * DELETES these when a target is dropped; `scaffold/add-target.ts` COPIES the
 * same entries back from the template when a target is added — sharing the
 * tables is what keeps prune ↔ add from drifting.
 */
/** Per-target npm scripts. */
export const TARGET_SCRIPTS: Record<PrunableTarget, string[]> = {
  desktop: ['dev:desktop', 'build:desktop'],
  web: ['serve', 'dev:web', 'build:web'],
};
/** Per-target runtime deps. */
export const TARGET_DEPS: Record<PrunableTarget, string[]> = {
  desktop: [], // desktop's exclusive deps are all devDeps
  web: ['@lloyal-labs/host', 'ws'],
};
/** Per-target devDeps. */
export const TARGET_DEV_DEPS: Record<PrunableTarget, string[]> = {
  desktop: ['electron', 'electron-vite'],
  web: ['@types/ws'],
};
/**
 * Top-level files (besides `targets/<t>/`) that belong ONLY to a target: its
 * bin shim / build config. Deleted on prune, copied back on add.
 */
export const TARGET_FILES: Record<PrunableTarget, string[]> = {
  desktop: ['electron.vite.config.ts', 'tsconfig.electron.json'],
  web: ['bin/serve.js'],
};
/**
 * Deps shared by the DOM renderers (web browser + Electron renderer). Kept while
 * EITHER desktop or web survives; removed only for a cli-only project. `vite` is
 * here because `electron-vite` lists it as a peerDependency.
 */
export const SHARED_RENDERER_DEPS = ['react-dom'];
export const SHARED_RENDERER_DEV_DEPS = ['@vitejs/plugin-react', '@types/react-dom', 'vite'];

/**
 * Reduce `<projectDir>` to `keep`. `keep` MUST include `'cli'`. A no-op when all
 * three targets are kept (beyond normalizing the `harness.yml` `targets:` line).
 */
export function pruneTargets(projectDir: string, keep: readonly Target[]): void {
  const keepSet = new Set(keep);
  if (!keepSet.has('cli')) {
    throw new Error("pruneTargets: 'cli' is mandatory and cannot be pruned");
  }
  const pruneDesktop = !keepSet.has('desktop');
  const pruneWeb = !keepSet.has('web');

  const rm = (rel: string): void => rmSync(join(projectDir, rel), { recursive: true, force: true });

  // 1. Dirs + files (the target's own dir + its exclusive top-level files).
  if (pruneDesktop) {
    rm('targets/desktop');
    for (const f of TARGET_FILES.desktop) rm(f);
  }
  if (pruneWeb) {
    rm('targets/web');
    for (const f of TARGET_FILES.web) rm(f);
  }

  // 2. package.json — scripts + deps.
  if (pruneDesktop || pruneWeb) {
    prunePackageJson(projectDir, { pruneDesktop, pruneWeb });
  }

  // 3. tsconfig split (only when a target was actually removed).
  if (pruneDesktop || pruneWeb) {
    const someDom = !pruneDesktop || !pruneWeb; // a DOM target (web or desktop renderer) remains
    const webCfg = join(projectDir, 'tsconfig.web.json');
    if (existsSync(webCfg)) {
      if (!someDom) {
        rm('tsconfig.web.json'); // cli-only: no DOM sources left to typecheck
      } else {
        filterJsoncArray(webCfg, 'include', (entry) => !isUnderPruned(entry, pruneDesktop, pruneWeb));
      }
    }
    const nodeCfg = join(projectDir, 'tsconfig.json');
    if (existsSync(nodeCfg)) {
      filterJsoncArray(nodeCfg, 'exclude', (entry) => !isUnderPruned(entry, pruneDesktop, pruneWeb));
    }
  }

  // 4. harness.yml `targets:` line (documentation).
  rewriteTargetsLine(projectDir, keep);
}

function prunePackageJson(
  projectDir: string,
  { pruneDesktop, pruneWeb }: { pruneDesktop: boolean; pruneWeb: boolean },
): void {
  const pkgPath = join(projectDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  const drop = (obj: Record<string, string> | undefined, keys: string[]): void => {
    if (!obj) return;
    for (const k of keys) delete obj[k];
  };

  if (pruneDesktop) {
    drop(pkg.scripts, TARGET_SCRIPTS.desktop);
    drop(pkg.dependencies, TARGET_DEPS.desktop);
    drop(pkg.devDependencies, TARGET_DEV_DEPS.desktop);
  }
  if (pruneWeb) {
    drop(pkg.scripts, TARGET_SCRIPTS.web);
    drop(pkg.dependencies, TARGET_DEPS.web);
    drop(pkg.devDependencies, TARGET_DEV_DEPS.web);
  }
  if (pruneDesktop && pruneWeb) {
    drop(pkg.dependencies, SHARED_RENDERER_DEPS);
    drop(pkg.devDependencies, SHARED_RENDERER_DEV_DEPS);
  }

  // Rebuild the `typecheck` script from the tsconfigs that survive.
  if (pkg.scripts?.typecheck) {
    const someDom = !pruneDesktop || !pruneWeb;
    const parts = ['tsc --noEmit'];
    if (someDom) parts.push('tsc -p tsconfig.web.json');
    if (!pruneDesktop) parts.push('tsc -p tsconfig.electron.json');
    pkg.scripts.typecheck = parts.join(' && ');
  }

  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

/** True when a tsconfig path entry lives under a pruned target directory. */
function isUnderPruned(entry: string, pruneDesktop: boolean, pruneWeb: boolean): boolean {
  return (
    (pruneDesktop && entry.startsWith('targets/desktop')) ||
    (pruneWeb && entry.startsWith('targets/web'))
  );
}

/** Rewrite the `targets: [...]` line in `harness.yml` to the given set. */
export function rewriteTargetsLine(projectDir: string, keep: readonly Target[]): void {
  const ymlPath = join(projectDir, 'harness.yml');
  if (!existsSync(ymlPath)) return;
  const text = readFileSync(ymlPath, 'utf8');
  const rendered = `targets: [${keep.join(', ')}]`;
  const next = text.replace(/^targets:\s*\[[^\]]*\]/m, rendered);
  if (next !== text) writeFileSync(ymlPath, next);
}
