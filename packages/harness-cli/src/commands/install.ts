import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import type { Command } from '../command';
import {
  fetchAndVerifyCatalog,
  resolveAppVersion,
  fetchAndVerifyManifest,
  verifyBundle,
  sha512Integrity,
  BundleVerificationError,
} from '../verify';

const USAGE = [
  'harness.dev install — install a signed HDK app from apps.lloyal.ai into the current project',
  '',
  'Usage:',
  '  npx harness.dev install [--allow-scripts] <name>[@<semver>]',
  '',
  'Options:',
  '  --allow-scripts   Permit the installed package\'s preinstall/postinstall hooks to run.',
  '                    Default is `npm install --ignore-scripts`. The signature attests',
  '                    to the tarball bytes\' provenance + Lloyal review, not to safety',
  '                    of arbitrary install scripts; opt in per-install if you trust the',
  '                    publisher.',
  '  -h, --help        Show this help',
  '',
  'Flow:',
  '  1. Fetch the signed catalog at apps.lloyal.ai/v1/catalog.json; Ed25519-verify',
  '     against the framework-vendored trust roots.',
  '  2. Resolve <name>[@<semver>] to a specific version entry.',
  '  3. Fetch the manifest; cross-check name/version/sizeBytes against the catalog.',
  '  4. Fetch the tarball; Ed25519-verify against the manifest\'s signature.',
  '  5. Compute sha512 integrity locally; cache the verified tarball at',
  '     $XDG_CACHE_HOME/lloyal/apps/<name>-<version>.tgz.',
  '  6. Shell out to `npm install [--ignore-scripts] <canonical-tarball-URL>` in cwd',
  '     so the package lands at node_modules/@lloyal-labs/<name>-app/, package.json',
  '     records the canonical channel URL, and package-lock.json records the sha512',
  '     integrity. CI thereafter installs the package with plain `npm ci` against the',
  '     committed lockfile — no harness.dev required in CI.',
  '  7. Audit: re-read the lockfile and confirm npm\'s recorded integrity matches what we',
  '     computed pre-install. If they diverge (R2 served different bytes between our',
  '     verify-fetch and npm\'s install-fetch), uninstall and error.',
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

    const { name, semver } = parseSpec(positionals[0]);
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(name)) {
      process.stderr.write(
        `harness.dev install: invalid app name "${name}" (expected [a-z][a-z0-9_-]{1,63})\n`,
      );
      return 1;
    }

    // 1-2. Catalog → version entry.
    let entry;
    try {
      const catalog = await fetchAndVerifyCatalog();
      entry = resolveAppVersion(catalog, name, { semver });
    } catch (err) {
      process.stderr.write(`harness.dev install: ${asMessage(err)}\n`);
      return 1;
    }

    process.stderr.write(
      `harness.dev install: resolved ${name}${semver ? `@${semver}` : ''} → ${name}@${entry.version}\n`,
    );

    // 3. Manifest fetch + cross-check.
    let manifest;
    let trustKey: Uint8Array;
    try {
      const out = await fetchAndVerifyManifest(entry, name);
      manifest = out.manifest;
      trustKey = out.trustKey;
    } catch (err) {
      process.stderr.write(`harness.dev install: ${asMessage(err)}\n`);
      return 1;
    }

    // 4. Tarball fetch + Ed25519 verify.
    let tarball: Uint8Array;
    try {
      const response = await fetch(entry.tarballUrl);
      if (!response.ok) {
        throw new BundleVerificationError(
          `Tarball fetch from ${entry.tarballUrl} returned HTTP ${response.status} ${response.statusText}.`,
        );
      }
      tarball = new Uint8Array(await response.arrayBuffer());
      if (tarball.byteLength !== manifest.sizeBytes) {
        throw new BundleVerificationError(
          `Tarball size ${tarball.byteLength} does not match manifest.sizeBytes ${manifest.sizeBytes}.`,
        );
      }
      const ok = await verifyBundle(tarball, manifest.signature, trustKey);
      if (!ok) {
        throw new BundleVerificationError(
          `Ed25519 signature verification failed for ${name}@${manifest.version} ` +
            `(publisherKeyId="${manifest.publisherKeyId}").`,
        );
      }
    } catch (err) {
      process.stderr.write(`harness.dev install: ${asMessage(err)}\n`);
      return 1;
    }

    // 5. Compute integrity + cache verified bytes.
    const expectedIntegrity = await sha512Integrity(tarball);
    const cacheDir = join(xdgCacheHome(), 'lloyal', 'apps');
    const cachePath = join(cacheDir, `${name}-${manifest.version}.tgz`);
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cachePath, tarball);
    } catch (err) {
      // Cache write failure is non-fatal — the install can still proceed
      // via npm fetching from the URL directly. Just warn.
      process.stderr.write(
        `harness.dev install: warning — could not write cache at ${cachePath}: ${asMessage(err)}\n`,
      );
    }

    // 6. Shell out to npm install <canonical-URL>.
    const allowScripts = values['allow-scripts'] === true;
    const npmArgs = ['install', ...(allowScripts ? [] : ['--ignore-scripts']), '--save', entry.tarballUrl];

    process.stderr.write(
      `harness.dev install: running \`npm ${npmArgs.join(' ')}\` in ${process.cwd()}...\n`,
    );

    const npmExit = await runNpm(npmArgs);
    if (npmExit !== 0) {
      process.stderr.write(`harness.dev install: npm install exited ${npmExit}\n`);
      return npmExit;
    }

    // 7. Audit lockfile integrity.
    const npmPackageName = `@lloyal-labs/${name}-app`;
    let actualIntegrity: string | null;
    try {
      actualIntegrity = await readLockfileIntegrity(npmPackageName);
    } catch (err) {
      process.stderr.write(
        `harness.dev install: warning — could not audit lockfile: ${asMessage(err)}\n`,
      );
      actualIntegrity = null;
    }

    if (actualIntegrity && actualIntegrity !== expectedIntegrity) {
      process.stderr.write(
        `harness.dev install: integrity mismatch — npm-installed bytes did not match ` +
          `our pre-verified bytes. Rolling back.\n` +
          `  expected: ${expectedIntegrity}\n` +
          `  actual:   ${actualIntegrity}\n`,
      );
      await runNpm(['uninstall', npmPackageName]);
      return 1;
    }

    process.stdout.write(`installed ${name}@${manifest.version}\n`);
    process.stdout.write(`  package:   ${npmPackageName}\n`);
    process.stdout.write(`  tarball:   ${entry.tarballUrl}\n`);
    process.stdout.write(`  integrity: ${expectedIntegrity}\n`);
    process.stdout.write(`  cached:    ${cachePath}\n`);
    return 0;
  },
};

/**
 * Parse `<name>` or `<name>@<semver>` into its parts. The `<name>` is
 * the catalog's short name (e.g., `web`), not the npm package name
 * (`@lloyal-labs/web-app`).
 */
function parseSpec(spec: string): { name: string; semver: string | undefined } {
  const atIdx = spec.indexOf('@');
  if (atIdx === -1) return { name: spec, semver: undefined };
  return { name: spec.slice(0, atIdx), semver: spec.slice(atIdx + 1) };
}

function xdgCacheHome(): string {
  return process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
}

/**
 * Spawn `npm <args>` in `process.cwd()` with inherited stdio so the user
 * sees npm's progress + warnings live.
 */
function runNpm(args: readonly string[]): Promise<number> {
  return new Promise<number>((resolvePromise) => {
    const proc = spawn('npm', [...args], { cwd: process.cwd(), stdio: 'inherit' });
    proc.on('error', () => resolvePromise(1));
    proc.on('close', (code) => resolvePromise(code ?? 1));
  });
}

/**
 * Read the `integrity` field for `npmPackageName` from
 * `<cwd>/package-lock.json`. Supports the npm v3 lockfile shape (the only
 * one npm 7+ writes). Returns null if the lockfile is absent (e.g., dry
 * run) — the caller treats this as "audit skipped."
 */
async function readLockfileIntegrity(npmPackageName: string): Promise<string | null> {
  const lockfilePath = join(process.cwd(), 'package-lock.json');
  let raw: string;
  try {
    raw = await readFile(lockfilePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const lockfile = JSON.parse(raw) as {
    packages?: Record<string, { integrity?: string; resolved?: string }>;
  };
  const entry = lockfile.packages?.[`node_modules/${npmPackageName}`];
  if (!entry) {
    throw new Error(
      `lockfile entry node_modules/${npmPackageName} not found — npm install may not have written the lockfile as expected`,
    );
  }
  if (!entry.integrity) {
    throw new Error(
      `lockfile entry node_modules/${npmPackageName} has no integrity field`,
    );
  }
  return entry.integrity;
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
