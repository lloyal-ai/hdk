/**
 * Regression: the CLI must dispatch when its bin is reached through a **symlink**
 * — which is how every real install runs it (`npx`, global `npm i -g`, `npm link`).
 *
 * The bin is a dumb shim (`bin/run.js`) that loads the library (`dist/cli.js`)
 * and calls its exported `run()`; the shim runs unconditionally, so there is no
 * "am I the main module?" self-check to break under a symlink. (An earlier design
 * fused the two into `dist/cli.js` and guarded on
 * `import.meta.url === pathToFileURL(process.argv[1])`, which never matched
 * through a symlink → the CLI silently exited 0 having done nothing.) Every other
 * test imports command modules directly and so never exercises the bin — this one
 * spawns it through a symlink, exactly as an installed bin does.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const binRun = join(here, '..', 'bin', 'run.js'); // the published bin (a shim)
const distCli = join(here, '..', 'dist', 'cli.js'); // the library the shim loads

describe('bin/run.js entrypoint (invoked via a bin symlink)', () => {
  beforeAll(() => {
    expect(existsSync(binRun), `missing shim ${binRun}`).toBe(true);
    expect(existsSync(distCli), `build first — missing ${distCli}`).toBe(true);
  });

  function symlinkedBin(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hd-bin-'));
    const link = join(dir, 'harness.dev'); // basename differs from the target, like a real bin
    symlinkSync(binRun, link);
    return link;
  }

  it('--help dispatches through the symlink (does not silently no-op)', () => {
    const out = execFileSync('node', [symlinkedBin(), '--help'], { encoding: 'utf8' });
    expect(out).toContain('harness.dev');
    expect(out).toMatch(/Scaffold/);
  });

  it('new <name> --yes scaffolds through the symlink', () => {
    const bin = symlinkedBin();
    const dest = mkdtempSync(join(tmpdir(), 'hd-scaffold-'));
    // `--skip-apps` keeps this hermetic. `new` otherwise fetches the template's
    // default AgentApps from apps.lloyal.ai on every path (it is no longer gated
    // on a TTY), and no fetch in the CLI carries an AbortSignal — so a runner
    // with blackholed egress would hang this test rather than fail it.
    const out = execFileSync('node', [bin, 'new', 'symapp', '--yes', '--skip-apps', '--dir', dest], {
      encoding: 'utf8',
    });
    expect(out).toContain('scaffolded symapp');
    expect(readdirSync(dest)).toContain('symapp');
    expect(existsSync(join(dest, 'symapp', 'harness.yml'))).toBe(true);
  });
});
