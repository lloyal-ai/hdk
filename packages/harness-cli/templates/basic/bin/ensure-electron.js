#!/usr/bin/env node
/**
 * Make sure the Electron binary is on disk before a desktop build/run.
 *
 * Electron 42 REMOVED the `postinstall: node install.js` hook from its published
 * package.json (41.x still had it). Nothing in `npm install` downloads the
 * binary any more, so `electron-vite` dies with "Error: Electron uninstall" on a
 * freshly installed project. `install.js` still ships inside the package — it
 * just has to be invoked. This runs it once, only when the binary is absent, so
 * the normal case costs a single `existsSync`.
 *
 * Wired as `predev:desktop` / `prebuild:desktop`, which also covers installs
 * that skip lifecycle scripts entirely (`npm ci --ignore-scripts`, npm 12's
 * `allowScripts` policy, pnpm's default).
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

let pkgDir;
try {
  pkgDir = dirname(require.resolve("electron/package.json"));
} catch {
  process.stderr.write(
    "ensure-electron: `electron` is not installed. Run `npm install` first.\n",
  );
  process.exit(1);
}

// electron writes the platform binary under dist/ and records it in path.txt.
if (existsSync(join(pkgDir, "dist"))) process.exit(0);

const installer = join(pkgDir, "install.js");
if (!existsSync(installer)) {
  process.stderr.write(
    `ensure-electron: no install.js in ${pkgDir} — cannot fetch the Electron binary.\n`,
  );
  process.exit(1);
}

process.stderr.write("Fetching the Electron binary (once, ~100MB)...\n");
const { status, error } = spawnSync(process.execPath, [installer], {
  cwd: pkgDir,
  stdio: "inherit",
});
if (error || status !== 0) {
  process.stderr.write(
    "ensure-electron: failed to fetch the Electron binary. Re-run, or do it by hand:\n" +
      `  node ${installer}\n`,
  );
  process.exit(1);
}
