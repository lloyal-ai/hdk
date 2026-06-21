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
import { readTarEntry } from '../tar-read';
import type { AttentionSurface } from '../describe';

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
  'Flow:',
  '  1. Fetch the signed catalog at apps.lloyal.ai/v1/catalog.json; Ed25519-verify',
  '     against the framework-vendored trust roots.',
  '  2. Resolve <publisher>/<name>[@<semver>] to a specific catalog version entry. The',
  '     entry carries the npm package name (`importName`, e.g. `@acme/jira-app`) — the',
  '     symbol the harness `import`s from once the tarball is installed.',
  '  3. Fetch the manifest; cross-check name/version/sizeBytes against the catalog.',
  '  4. Fetch the tarball; Ed25519-verify against the manifest\'s signature.',
  '  5. Compute sha512 integrity locally; cache the verified tarball at',
  '     $XDG_CACHE_HOME/lloyal/apps/<publisher>__<name>-<version>.tgz.',
  '  6. Shell out to `npm install [--ignore-scripts] <canonical-tarball-URL>` in cwd',
  '     so the package lands at node_modules/<importName>/, package.json records the',
  '     canonical channel URL, and package-lock.json records the sha512 integrity. CI',
  '     thereafter installs the package with plain `npm ci` against the committed',
  '     lockfile — no harness.dev required in CI.',
  '  7. Audit: re-read the lockfile and confirm npm\'s recorded integrity matches what we',
  '     computed pre-install. If they diverge (R2 served different bytes between our',
  '     verify-fetch and npm\'s install-fetch), uninstall and error.',
].join('\n');

/**
 * Spec grammar: `<publisher>/<name>[@<semver>]` (post-W) or back-compat
 * `<name>[@<semver>]` (lloyal-internal pre-W entries, which never reached
 * external publish). Both segments of the scoped form match the app/handle
 * grammar `[a-z][a-z0-9_-]{1,63}`.
 */
const SCOPED_NAME_PATTERN =
  /^[a-z][a-z0-9_-]{1,63}\/[a-z][a-z0-9_-]{1,63}$/;
const UNSCOPED_NAME_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

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
    if (!SCOPED_NAME_PATTERN.test(name) && !UNSCOPED_NAME_PATTERN.test(name)) {
      process.stderr.write(
        `harness.dev install: invalid app name "${name}" — expected ` +
          '`<publisher>/<short-name>` (e.g., `lloyal/web`, `acme/jira`).\n',
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

    // 5. Compute integrity + cache verified bytes. Scoped catalog names
    // (`<publisher>/<short>`) are flat-encoded for the cache filename
    // (`<publisher>__<short>`), matching the channel's R2 path convention.
    const expectedIntegrity = await sha512Integrity(tarball);

    // 5a. Cross-check the signed manifest's `integrity` field against the
    // sha512 we just computed over the actually-received bytes. The Ed25519
    // signature is the real trust gate; this guards against a signing-pipeline
    // bug emitting an integrity that doesn't match what was signed. Loud
    // failure here points the operator at the Worker, not the consumer.
    if (manifest.integrity !== expectedIntegrity) {
      process.stderr.write(
        `harness.dev install: manifest integrity ${manifest.integrity} does not match ` +
          `sha512 of received tarball bytes ${expectedIntegrity}. ` +
          `This indicates a signing-pipeline bug — file an issue at https://github.com/lloyal-ai/hdk.\n`,
      );
      return 1;
    }

    // 5b. Disclose what this app injects into the model's context, read from the
    // ALREADY-VERIFIED tarball bytes (the attention surface rides inside the signed
    // package). Absent for apps published before the feature — note + continue.
    await renderAttentionSurface(tarball, name);

    const cacheDir = join(xdgCacheHome(), 'lloyal', 'apps');
    const cachePath = join(
      cacheDir,
      `${flatEncodeScopedName(name)}-${manifest.version}.tgz`,
    );
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

    // 7. Audit lockfile + package.json. The npm package name comes from the
    // catalog entry's `importName` — the symbol the consumer `import`s from
    // once installed, and the lockfile key npm writes. Every audit failure
    // rolls back via `npm uninstall` and exits non-zero. The PR's
    // CI-reproducibility promise depends on these invariants holding; we
    // refuse to leave a half-good install in place.
    const npmPackageName = entry.importName;
    let audit: LockfileAudit | null;
    try {
      audit = await auditLockfile(npmPackageName);
    } catch (err) {
      process.stderr.write(
        `harness.dev install: audit failed — ${asMessage(err)}. Rolling back.\n`,
      );
      await runNpm(['uninstall', npmPackageName]);
      return 1;
    }

    if (audit === null) {
      process.stderr.write(
        `harness.dev install: package-lock.json is required for a reproducible install but ` +
          `is absent. Run \`npm config set package-lock true\` (or drop \`--no-package-lock\`) ` +
          `and re-run. Rolling back.\n`,
      );
      await runNpm(['uninstall', npmPackageName]);
      return 1;
    }

    if (audit.integrity !== expectedIntegrity) {
      process.stderr.write(
        `harness.dev install: integrity mismatch — npm-installed bytes did not match ` +
          `our pre-verified bytes. Rolling back.\n` +
          `  expected: ${expectedIntegrity}\n` +
          `  actual:   ${audit.integrity}\n`,
      );
      await runNpm(['uninstall', npmPackageName]);
      return 1;
    }

    if (audit.resolved !== entry.tarballUrl) {
      process.stderr.write(
        `harness.dev install: lockfile resolved URL does not match the canonical channel URL. ` +
          `CI cannot reproduce this install. Rolling back.\n` +
          `  expected: ${entry.tarballUrl}\n` +
          `  actual:   ${audit.resolved}\n`,
      );
      await runNpm(['uninstall', npmPackageName]);
      return 1;
    }

    if (audit.savedDepSpec !== entry.tarballUrl) {
      process.stderr.write(
        `harness.dev install: package.json dependencies.${npmPackageName} does not equal the ` +
          `canonical channel URL. CI cannot reproduce this install. Rolling back.\n` +
          `  expected: ${entry.tarballUrl}\n` +
          `  actual:   ${audit.savedDepSpec}\n`,
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
 * Parse `<scoped-name>` or `<scoped-name>@<semver>` into its parts. The
 * `<scoped-name>` is the catalog identifier (e.g., `lloyal/web`,
 * `acme/jira`), not the npm package name — the catalog entry's
 * `importName` field carries that.
 *
 * Scoped names contain `/` but never `@`, so the first `@` (if any) is
 * unambiguously the semver delimiter.
 */
function parseSpec(spec: string): { name: string; semver: string | undefined } {
  const atIdx = spec.indexOf('@');
  if (atIdx === -1) return { name: spec, semver: undefined };
  return { name: spec.slice(0, atIdx), semver: spec.slice(atIdx + 1) };
}

/**
 * Flatten a scoped catalog name like `lloyal/web` to `lloyal__web` for
 * use in a filesystem cache path. Mirrors the R2 channel encoding the
 * Worker writes on approval.
 */
function flatEncodeScopedName(name: string): string {
  return name.replace('/', '__');
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
 * Result of auditing `<cwd>/package-lock.json` + `<cwd>/package.json` for an
 * install of `npmPackageName`. Carries every invariant the install path
 * promises: the integrity (matches what npm computed against the tarball it
 * fetched), the lockfile's `resolved` URL (matches the canonical channel
 * URL), and the dep spec saved into `package.json` (also the canonical URL).
 * All three must hold for CI to reproduce the install with plain `npm ci`.
 */
export interface LockfileAudit {
  /** sha512 integrity npm recorded for `node_modules/<npmPackageName>`. */
  integrity: string;
  /** `resolved` field from the lockfile entry — should equal the catalog `tarballUrl`. */
  resolved: string;
  /** Saved dep spec in package.json's dependencies — also should equal `tarballUrl`. */
  savedDepSpec: string;
}

/**
 * Audit `<cwd>/package-lock.json` + `<cwd>/package.json` for `npmPackageName`.
 *
 * Returns `null` if the lockfile is genuinely absent (ENOENT). The caller
 * treats `null` as "lockfile required by this install" and fails loud +
 * rolls back — the PR's CI-reproducibility promise depends on a lockfile
 * being present.
 *
 * Any other shape error (lockfile malformed JSON, missing
 * `node_modules/<npmPackageName>` entry, missing `integrity` or `resolved`
 * field, package.json missing or missing the dep spec) throws with a clear
 * message. The caller catches + rolls back.
 */
async function auditLockfile(npmPackageName: string): Promise<LockfileAudit | null> {
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
  if (!lockEntry.integrity) {
    throw new Error(
      `lockfile entry node_modules/${npmPackageName} has no integrity field`,
    );
  }
  if (!lockEntry.resolved) {
    throw new Error(
      `lockfile entry node_modules/${npmPackageName} has no resolved field`,
    );
  }

  // package.json side. ENOENT here is a hard error: npm install --save
  // either wrote it or the cwd was wrong; either way the install contract
  // failed.
  const pkgPath = join(process.cwd(), 'package.json');
  let pkgRaw: string;
  try {
    pkgRaw = await readFile(pkgPath, 'utf-8');
  } catch (err) {
    throw new Error(`could not read package.json: ${(err as Error).message}`);
  }
  let pkg: { dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(pkgRaw);
  } catch (err) {
    throw new Error(`package.json is not valid JSON: ${(err as Error).message}`);
  }
  const savedDepSpec = pkg.dependencies?.[npmPackageName];
  if (!savedDepSpec) {
    throw new Error(
      `package.json dependencies.${npmPackageName} is missing — npm install --save did not record the dep`,
    );
  }

  return {
    integrity: lockEntry.integrity,
    resolved: lockEntry.resolved,
    savedDepSpec,
  };
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Print the app's attention surface — exactly what it injects into the model's
 * context — read from the Ed25519-verified tarball bytes. Best-effort disclosure:
 * a parse failure or a pre-feature app degrades to a one-line note, never blocks.
 */
async function renderAttentionSurface(tarball: Uint8Array, name: string): Promise<void> {
  const raw = await readTarEntry(tarball, 'package/attention-surface.json');
  if (raw === null) {
    process.stdout.write(
      `\n  note: ${name} ships no attention-surface.json (published before context disclosure).\n`,
    );
    return;
  }
  let s: AttentionSurface;
  try {
    s = JSON.parse(raw) as AttentionSurface;
  } catch {
    process.stdout.write(`\n  note: ${name}'s attention surface could not be parsed.\n`);
    return;
  }
  const out = process.stdout;
  out.write(`\nWhat ${name} adds to your model's context:\n`);
  if (s.protocol?.name) out.write(`  protocol:  ${s.protocol.name}\n`);
  if (s.protocol?.useWhen) out.write(`  use when:  ${s.protocol.useWhen}\n`);

  const tools = Array.isArray(s.tools) ? s.tools : [];
  out.write(`\n  Tools (${tools.length}):\n`);
  for (const t of tools) {
    const tag = t.protected ? '  [writes]' : '';
    const desc = t.description ? ` — ${t.description}` : '';
    out.write(`    • ${t.name}${desc}${tag}\n`);
  }
  if (s.degraded) {
    out.write('    (tool descriptions unavailable for this version)\n');
  }

  const props = (s.configSchema as { properties?: Record<string, { type?: string; 'x-secret'?: boolean }> } | undefined)
    ?.properties;
  const keys = props ? Object.keys(props) : [];
  if (keys.length) {
    out.write('\n  Config it reads:\n');
    for (const k of keys) {
      const secret = props![k]?.['x-secret'] ? ', secret' : '';
      out.write(`    • ${k} (${props![k]?.type ?? 'value'}${secret})\n`);
    }
  }

  if (s.skill) {
    const lines = s.skill.split('\n');
    const shown = lines.slice(0, 10);
    out.write('\n  System-prompt skill (per turn):\n');
    for (const l of shown) out.write(`    | ${l}\n`);
    if (lines.length > shown.length) out.write(`    | … (${lines.length - shown.length} more lines)\n`);
  }
  out.write('\n');
}
