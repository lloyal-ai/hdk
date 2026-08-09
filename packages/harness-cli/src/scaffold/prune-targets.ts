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
  // The `pre*` hooks fetch the Electron binary on demand — see
  // `templates/*/bin/ensure-electron.js` for why that is not npm's job any more.
  desktop: ['predev:desktop', 'dev:desktop', 'prebuild:desktop', 'build:desktop'],
  web: ['serve', 'dev:web', 'dev:web:client', 'build:web'],
};
/**
 * Per-target TOP-LEVEL package.json fields. `main` is Electron's entry point —
 * electron-vite refuses to launch without it ("No entry point found for electron
 * app") — and it names a path under `out/`, which only a desktop build produces.
 * So it belongs to desktop and is dropped with it, exactly like a script or dep.
 */
export const TARGET_PKG_FIELDS: Record<PrunableTarget, string[]> = {
  desktop: ['main'],
  web: [],
};
/** Per-target runtime deps. */
export const TARGET_DEPS: Record<PrunableTarget, string[]> = {
  desktop: [], // desktop's exclusive deps are all devDeps
  web: ['@lloyal-labs/host', 'ws'],
};
/** Per-target devDeps. */
export const TARGET_DEV_DEPS: Record<PrunableTarget, string[]> = {
  desktop: ['electron', 'electron-vite'],
  web: ['@types/ws', 'concurrently'],
};
/**
 * Top-level files (besides `targets/<t>/`) that belong ONLY to a target: its
 * bin shim / build config. Deleted on prune, copied back on add.
 */
export const TARGET_FILES: Record<PrunableTarget, string[]> = {
  desktop: ['electron.vite.config.ts', 'tsconfig.electron.json', 'bin/ensure-electron.js'],
  web: ['bin/serve.js'],
};
/**
 * Deps shared by the DOM renderers (web browser + Electron renderer). Kept while
 * EITHER desktop or web survives; removed only for a cli-only project. `vite` is
 * here because `electron-vite` lists it as a peerDependency.
 */
export const SHARED_RENDERER_DEPS = ['react-dom', 'react-markdown', 'remark-gfm'];
export const SHARED_RENDERER_DEV_DEPS = ['@vitejs/plugin-react', '@types/react-dom', 'vite'];
/**
 * The React view itself (`App.tsx` + whatever it pulls in), on exactly the same
 * lifecycle as the deps above — kept while EITHER DOM target survives.
 *
 * It lives in its own dir rather than inside `targets/desktop/` because it is
 * shared: web's `main.tsx` and desktop's `view.tsx` both mount it. Parking it in
 * one target meant pruning that target stranded the other's import, which broke
 * `--targets cli,web` and, worse, broke a WORKING project on
 * `targets:remove desktop`. Do not move it back under a target dir.
 */
export const SHARED_RENDERER_DIR = 'targets/_shared';

/**
 * Refuse to operate on a project laid out the pre-0.9 way (React view still
 * inside `targets/desktop/`).
 *
 * 0.9 is a clean break — there is deliberately no migration. But breaking
 * loudly and breaking silently are different things, and without this check the
 * `targets:` verbs do the latter: `targets:add web` writes a `web/main.tsx`
 * importing `../_shared/App.js` into a project that has no `_shared`, then
 * reports success. Say so instead.
 *
 * A cli-only project legitimately has no `_shared` — nothing mounts the view —
 * so the check keys off a DOM target being present.
 */
export function assertSharedViewLayout(projectDir: string): void {
  const hasDom = (['desktop', 'web'] as const).some((t) =>
    existsSync(join(projectDir, 'targets', t)),
  );
  if (!hasDom || existsSync(join(projectDir, SHARED_RENDERER_DIR))) return;
  throw new Error(
    'this project predates harness.dev 0.9 — its React view is still inside ' +
      '`targets/desktop/`, but the `targets:` verbs now expect `targets/_shared/`.\n' +
      '  0.9 moved the shared view so that removing desktop stops breaking the web build.\n' +
      '  There is no migration path. Scaffold a fresh project with `npx harness.dev new` ' +
      'and copy your `harness/` (and your view) across.',
  );
}

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
  // The shared view outlives either target alone; only a cli-only project has
  // nothing left to mount it. Same guard `prunePackageJson` uses for the deps.
  if (pruneDesktop && pruneWeb) rm(SHARED_RENDERER_DIR);

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
      // `targets/_shared` matches neither pruned prefix, so it survives a
      // single-target prune on its own — correct, the dir survives too. Only a
      // cli-only prune deletes the dir, and then its exclude entry must go with
      // it or it dangles.
      filterJsoncArray(
        nodeCfg,
        'exclude',
        (entry) =>
          !isUnderPruned(entry, pruneDesktop, pruneWeb) &&
          !(!someDom && entry.startsWith(SHARED_RENDERER_DIR)),
      );
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
    [k: string]: unknown;
  };

  const drop = (obj: Record<string, string> | undefined, keys: string[]): void => {
    if (!obj) return;
    for (const k of keys) delete obj[k];
  };

  if (pruneDesktop) {
    drop(pkg.scripts, TARGET_SCRIPTS.desktop);
    drop(pkg.dependencies, TARGET_DEPS.desktop);
    drop(pkg.devDependencies, TARGET_DEV_DEPS.desktop);
    for (const f of TARGET_PKG_FIELDS.desktop) delete pkg[f];
  }
  if (pruneWeb) {
    drop(pkg.scripts, TARGET_SCRIPTS.web);
    drop(pkg.dependencies, TARGET_DEPS.web);
    drop(pkg.devDependencies, TARGET_DEV_DEPS.web);
    for (const f of TARGET_PKG_FIELDS.web) delete pkg[f];
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
