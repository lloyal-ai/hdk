/**
 * The placement gate: this package is browser code, so nothing it ships may
 * reach the backend. A React app bundles `dist/` directly, and a bundler's only
 * warning about a Node builtin is a broken page at runtime — so the check is a
 * law, not a convention.
 *
 * It reads what is SHIPPED (`dist/`) and what is DECLARED (the manifest),
 * because either one can let the backend in: an import someone adds, or a
 * dependency someone installs.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const here = new URL('.', import.meta.url).pathname;
const dist = join(here, '..', 'dist');
const manifest = createRequire(import.meta.url)('../package.json') as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

/** Node's own modules, by the two spellings a bundler sees. */
const BUILTINS = [
  'assert', 'buffer', 'child_process', 'crypto', 'dns', 'events', 'fs', 'http', 'http2', 'https', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'readline', 'stream', 'timers', 'tls', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
];

/** Packages that run the model or serve it — none of them belongs in a page. */
const BACKEND = ['@lloyal-labs/rig', '@lloyal-labs/host', '@lloyal-labs/sdk', '@lloyal-labs/lloyal-agents', '@lloyal-labs/lloyal.node', 'ws', 'effection'];

function emitted(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return emitted(full);
    return full.endsWith('.js') ? [full] : [];
  });
}

/** Every module specifier the file names, from both spellings the emitted CommonJS uses. */
function specifiers(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [
    ...Array.from(src.matchAll(/require\((['"])([^'"]+)\1\)/g), (m) => m[2]),
    ...Array.from(src.matchAll(/\bfrom\s*(['"])([^'"]+)\1/g), (m) => m[2]),
  ];
}

describe('@lloyal-labs/ui is browser code', () => {
  it('ships nothing that imports a Node builtin', () => {
    const files = emitted(dist);
    expect(files.length).toBeGreaterThan(0);   // an empty dist would pass vacuously
    const offenders = files.flatMap((f) =>
      specifiers(f)
        .filter((s) => s.startsWith('node:') || BUILTINS.includes(s))
        .map((s) => `${f.slice(dist.length + 1)} → ${s}`));
    expect(offenders).toEqual([]);
  });

  it('declares no backend package as a dependency or a peer', () => {
    const named = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})];
    expect(named.filter((n) => BACKEND.includes(n))).toEqual([]);
  });
});
