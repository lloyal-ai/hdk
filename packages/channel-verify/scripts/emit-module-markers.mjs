/**
 * Stamp a `type` marker into each half of the dual build.
 *
 * Node decides whether a `.js` file is CommonJS or ESM from the nearest
 * `package.json`'s `type` field. Without these two files both halves inherit
 * the package root's `"type": "commonjs"`, and `dist/esm/index.js` — real ESM
 * with `export` statements — would be loaded as CommonJS and fail at parse.
 *
 * Written at build time rather than committed because `dist/` is gitignored.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const [dir, type] of [
  ['cjs', 'commonjs'],
  ['esm', 'module'],
]) {
  writeFileSync(
    join(pkgRoot, 'dist', dir, 'package.json'),
    `${JSON.stringify({ type }, null, 2)}\n`,
  );
}
