import { parseArgs } from 'node:util';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Command } from '../command.js';
import { BundleVerificationError } from '../verify.js';
import {
  parseAppSpec,
  verifyAndVendorApp,
  InvalidAppSpecError,
  type VendoredApp,
} from '../scaffold/vendor-app.js';

const USAGE = [
  'harness.dev install — install a signed HDK app from apps.lloyal.ai into the current project',
  '',
  'Usage:',
  '  npx harness.dev install [--allow-scripts] <publisher>/<name>[@<semver>]',
  '',
  'Examples:',
  '  harness.dev install lloyal/web',
  '  harness.dev install lloyal/corpus@^1.0.0',
  '  harness.dev install acme/jira@1.2.3',
  '',
  'Options:',
  '  --allow-scripts   Permit the installed package\'s preinstall/postinstall hooks to run.',
  '                    Default is `npm install --ignore-scripts`. The signature attests',
  '                    to the tarball bytes\' provenance + Lloyal review, not to safety',
  '                    of arbitrary install scripts; opt in per-install if you trust the',
  '                    publisher.',
  '  -h, --help        Show this help',
  '',
  'Flow (npm never fetches a remote URL — the CLI verifies, then vendors locally):',
  '  1. Fetch the signed catalog at apps.lloyal.ai/v1/catalog.json; Ed25519-verify',
  '     against the framework-vendored trust roots.',
  '  2. Resolve <publisher>/<name>[@<semver>] to a specific catalog version entry. The',
  '     entry carries the npm package name (`importName`, e.g. `@acme/jira-app`) — the',
  '     symbol the harness `import`s from once the tarball is installed.',
  '  3. Fetch the manifest; cross-check name/version/sizeBytes against the catalog.',
  '  4. Fetch the tarball; Ed25519-verify against the manifest\'s signature; cross-check',
  '     its sha512 against the signed manifest.integrity.',
  '  5. Write the VERIFIED tarball + its signed manifest into `vendor/<pub>__<name>-<ver>.tgz`',
  '     and point package.json at it with a `file:` dependency. Commit `vendor/` so CI',
  '     reproduces the install offline with plain `npm ci` — no remote fetch, no',
  '     harness.dev, no `--allow-remote`.',
  '  6. Run `npm install [--ignore-scripts]` so npm materializes the local `file:` dep',
  '     into node_modules and records it in package-lock.json.',
  '  7. Audit: confirm npm installed the package and — if npm recorded an integrity for',
  '     the local tarball — that it matches the sha512 we verified. On any mismatch,',
  '     uninstall + remove the vendored bytes and error.',
].join('\n');

export const installCommand: Command = {
  name: 'install',
  summary: 'Install a signed HDK app from apps.lloyal.ai into the current project',
  usage: USAGE,
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        help: { type: 'boolean', short: 'h' },
        'allow-scripts': { type: 'boolean' },
      },
      allowPositionals: true,
    });

    if (values.help) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }

    if (positionals.length === 0) {
      process.stderr.write('harness.dev install: missing <name>[@<semver>] argument\n\n');
      process.stderr.write(`${USAGE}\n`);
      return 1;
    }
    if (positionals.length > 1) {
      process.stderr.write(
        `harness.dev install: expected exactly one <name>[@<semver>] argument, got ${positionals.length}\n`,
      );
      return 1;
    }

    let spec;
    try {
      spec = parseAppSpec(positionals[0]);
    } catch (err) {
      if (err instanceof InvalidAppSpecError) {
        process.stderr.write(`harness.dev install: ${err.message}\n`);
        return 1;
      }
      throw err;
    }

    // 1-5. Verify + vendor the signed bytes as a local `file:` dependency. Any
    // verify/write failure throws here — BEFORE npm is ever invoked and before
    // anything lands in the project — so a signing-pipeline bug or a tampered
    // tarball can never reach `npm install`.
    let vendored: VendoredApp;
    try {
      vendored = await verifyAndVendorApp(process.cwd(), spec, { disclose: true });
    } catch (err) {
      process.stderr.write(`harness.dev install: ${asMessage(err)}\n`);
      return 1;
    }

    process.stderr.write(
      `harness.dev install: verified ${vendored.name}@${vendored.version} → ${vendored.vendorRelPath}\n`,
    );

    // 6. Materialize the local `file:` dep into node_modules + package-lock.json.
    const allowScripts = values['allow-scripts'] === true;
    const npmArgs = ['install', ...(allowScripts ? [] : ['--ignore-scripts'])];

    process.stderr.write(
      `harness.dev install: running \`npm ${npmArgs.join(' ')}\` in ${process.cwd()}...\n`,
    );

    const npmExit = await runNpm(npmArgs);
    if (npmExit !== 0) {
      process.stderr.write(`harness.dev install: npm install exited ${npmExit}\n`);
      await rollback(vendored);
      return npmExit;
    }

    // 7. Audit: npm must have installed the package, and any integrity it
    // recorded for the local tarball must match the sha512 we verified. Every
    // audit failure rolls back (uninstall + remove the vendored bytes).
    let audit: InstallAudit | null;
    try {
      audit = await auditInstall(vendored.importName);
    } catch (err) {
      process.stderr.write(
        `harness.dev install: audit failed — ${asMessage(err)}. Rolling back.\n`,
      );
      await rollback(vendored);
      return 1;
    }

    if (audit === null) {
      process.stderr.write(
        `harness.dev install: package-lock.json is required for a reproducible install but ` +
          `is absent. Run \`npm config set package-lock true\` (or drop \`--no-package-lock\`) ` +
          `and re-run. Rolling back.\n`,
      );
      await rollback(vendored);
      return 1;
    }

    // npm records a sha512 integrity for a local `file:*.tgz` dependency; if
    // present it MUST match the bytes we Ed25519-verified. If a given npm version
    // omits it for a local tarball, the Ed25519 signature + our own pre-install
    // sha512 already gate integrity — so a missing lockfile integrity is not a
    // failure, only a divergent one is.
    if (audit.integrity !== null && audit.integrity !== vendored.integrity) {
      process.stderr.write(
        `harness.dev install: integrity mismatch — npm-installed bytes did not match ` +
          `the bytes we verified. Rolling back.\n` +
          `  expected: ${vendored.integrity}\n` +
          `  actual:   ${audit.integrity}\n`,
      );
      await rollback(vendored);
      return 1;
    }

    process.stdout.write(`installed ${vendored.name}@${vendored.version}\n`);
    process.stdout.write(`  package:   ${vendored.importName}\n`);
    process.stdout.write(`  vendored:  ${vendored.vendorRelPath}\n`);
    process.stdout.write(`  integrity: ${vendored.integrity}\n`);
    return 0;
  },
};

/**
 * Result of auditing `<cwd>/package-lock.json` for the installed package.
 * `integrity` is what npm recorded for the local tarball node, or `null` when
 * npm did not record one (some npm versions omit it for `file:` deps).
 */
export interface InstallAudit {
  integrity: string | null;
}

/**
 * Audit `<cwd>/package-lock.json` for `npmPackageName`.
 *
 * Returns `null` if the lockfile is genuinely absent (ENOENT) — the caller
 * treats that as "lockfile required" and fails loud + rolls back. Throws with a
 * clear message on any other shape error (malformed JSON, missing
 * `node_modules/<pkg>` entry). The caller catches + rolls back.
 */
async function auditInstall(npmPackageName: string): Promise<InstallAudit | null> {
  const lockfilePath = join(process.cwd(), 'package-lock.json');
  let lockRaw: string;
  try {
    lockRaw = await readFile(lockfilePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let lockfile: {
    packages?: Record<string, { integrity?: string; resolved?: string }>;
  };
  try {
    lockfile = JSON.parse(lockRaw);
  } catch (err) {
    throw new Error(`package-lock.json is not valid JSON: ${(err as Error).message}`);
  }
  const lockEntry = lockfile.packages?.[`node_modules/${npmPackageName}`];
  if (!lockEntry) {
    throw new Error(
      `lockfile entry node_modules/${npmPackageName} not found — npm install may not have written the lockfile as expected`,
    );
  }
  return { integrity: lockEntry.integrity ?? null };
}

/**
 * Undo a failed install: drop the dep from package.json (via `npm uninstall`)
 * and remove the vendored tarball + manifest. Best-effort — a rollback failure
 * is logged, not thrown, so the original error is what surfaces.
 */
async function rollback(vendored: VendoredApp): Promise<void> {
  await runNpm(['uninstall', vendored.importName]);
  const base = vendored.vendorRelPath.replace(/\.tgz$/, '');
  await rm(join(process.cwd(), vendored.vendorRelPath), { force: true }).catch(() => {});
  await rm(join(process.cwd(), `${base}.manifest.json`), { force: true }).catch(() => {});
}

/**
 * Spawn `npm <args>` in `process.cwd()` with inherited stdio so the user sees
 * npm's progress + warnings live.
 */
function runNpm(args: readonly string[]): Promise<number> {
  return new Promise<number>((resolvePromise) => {
    const proc = spawn('npm', [...args], { cwd: process.cwd(), stdio: 'inherit' });
    proc.on('error', () => resolvePromise(1));
    proc.on('close', (code) => resolvePromise(code ?? 1));
  });
}

function asMessage(err: unknown): string {
  if (err instanceof BundleVerificationError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
