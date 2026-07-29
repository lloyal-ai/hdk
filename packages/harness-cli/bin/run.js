#!/usr/bin/env node
/**
 * harness.dev — entrypoint for `npx harness.dev` and a global install.
 *
 * A dumb shim: load the built CLI library and run it. Keeping the bin separate
 * from the library (`dist/cli.js`) is what makes it robust — the shim runs
 * unconditionally, so there is no "am I the main module?" self-check to break
 * when the bin is reached through a symlink (npx / `npm i -g` / `npm link`).
 * This is the same shape every scaffolded harness ships (`bin/run.js`).
 */
import('../dist/cli.js')
  .then((m) => m.run())
  .catch((err) => {
    process.stderr.write(`Error: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
