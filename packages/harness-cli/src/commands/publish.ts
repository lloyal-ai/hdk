import { parseArgs } from 'node:util';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import type { Command } from '../command';
import { ensureFreshToken } from '../cf-access-oauth';

const DEFAULT_ENDPOINT = 'https://api.lloyal.ai/v1/publish';

const USAGE = [
  'harness.dev publish — submit an HDK app to apps.lloyal.ai for review + signing',
  '',
  'Usage:',
  '  npx harness.dev publish [--dir <path>] [--endpoint <url>]',
  '',
  'Options:',
  '  --dir <path>      App directory (default: cwd)',
  '  --endpoint <url>  Override the publish endpoint (default: ' + DEFAULT_ENDPOINT + ')',
  '  -h, --help        Show this help',
  '',
  'Runs `npm pack` in the app directory to produce a standard tarball, then',
  'POSTs the .tgz bytes + a small manifest stub to the publish endpoint. The',
  'endpoint is protected by Cloudflare Access — the CLI authenticates in one',
  'of two modes:',
  '',
  '  Service Token (CI): CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET env vars.',
  '  Interactive (dev):  Opens a browser for SSO on first run. Caches the token at',
  '                      $XDG_CACHE_HOME/lloyal/auth.json (default ~/.cache/lloyal/',
  '                      auth.json), mode 0600. Subsequent publishes are silent',
  '                      until the grant expires.',
  '',
  'The CLI never signs. Lloyal signs every tarball with the platform key after',
  'review; the Worker also computes the npm-compatible sha512 integrity over the',
  'same bytes and writes both into the catalog manifest.',
].join('\n');

interface AppJson {
  name: string;
  version: string;
  appProtocolVersion?: string;
  protocol?: { name?: string; useWhen?: string; tools?: string[] };
}

interface PackageJson {
  name: string;
  version: string;
  peerDependencies?: Record<string, string>;
}

interface ManifestStub {
  name: string;
  version: string;
  entry: string;
  sizeBytes: number;
  peerDependencies?: Record<string, string>;
}

export const publishCommand: Command = {
  name: 'publish',
  summary: 'Submit an HDK app to apps.lloyal.ai for review + signing',
  usage: USAGE,
  async run(argv) {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        help: { type: 'boolean', short: 'h' },
        dir: { type: 'string' },
        endpoint: { type: 'string' },
      },
      allowPositionals: false,
    });

    if (values.help) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }

    const appDir = resolve(values.dir ?? process.cwd());
    const endpoint = values.endpoint ?? DEFAULT_ENDPOINT;

    // Read app.json for protocol metadata + manifest name/version.
    let appJson: AppJson;
    try {
      const raw = await readFile(join(appDir, 'app.json'), 'utf-8');
      appJson = JSON.parse(raw) as AppJson;
    } catch (err) {
      process.stderr.write(`harness.dev publish: cannot read ${join(appDir, 'app.json')}: ${asMessage(err)}\n`);
      return 1;
    }

    if (typeof appJson.name !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/.test(appJson.name)) {
      process.stderr.write(`harness.dev publish: invalid app.json "name" (expected [a-z][a-z0-9_-]{1,63})\n`);
      return 1;
    }
    if (typeof appJson.version !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(appJson.version)) {
      process.stderr.write(`harness.dev publish: invalid app.json "version" (expected semver)\n`);
      return 1;
    }

    // Read package.json for peerDependencies — npm pack uses package.json
    // as the source of truth for the published tarball's metadata, and
    // peerDependencies need to flow into the catalog manifest so consumers
    // can see them pre-install.
    let packageJson: PackageJson;
    try {
      const raw = await readFile(join(appDir, 'package.json'), 'utf-8');
      packageJson = JSON.parse(raw) as PackageJson;
    } catch (err) {
      process.stderr.write(`harness.dev publish: cannot read ${join(appDir, 'package.json')}: ${asMessage(err)}\n`);
      return 1;
    }

    // Build the tarball via `npm pack` shell-out.
    let tarballPath: string;
    let packTmpDir: string;
    try {
      packTmpDir = await mkdtemp(join(tmpdir(), 'harness-dev-publish-'));
      tarballPath = await npmPack(appDir, packTmpDir);
    } catch (err) {
      process.stderr.write(`harness.dev publish: npm pack failed: ${asMessage(err)}\n`);
      return 1;
    }

    let tarball: Uint8Array;
    try {
      tarball = new Uint8Array(await readFile(tarballPath));
    } catch (err) {
      process.stderr.write(`harness.dev publish: cannot read packed tarball: ${asMessage(err)}\n`);
      await cleanupTmpDir(packTmpDir);
      return 1;
    }

    const stub: ManifestStub = {
      name: appJson.name,
      version: appJson.version,
      entry: `${appJson.name}-${appJson.version}.tgz`,
      sizeBytes: tarball.byteLength,
      peerDependencies: packageJson.peerDependencies,
    };

    let headers: Record<string, string>;
    try {
      headers = await buildAuthHeaders(endpoint);
    } catch (err) {
      process.stderr.write(`harness.dev publish: ${asMessage(err)}\n`);
      await cleanupTmpDir(packTmpDir);
      return 1;
    }

    // Copy into a fresh ArrayBuffer — Blob constructor wants
    // Uint8Array<ArrayBuffer>, not Uint8Array<ArrayBufferLike>.
    const tarballBuffer = new ArrayBuffer(tarball.byteLength);
    new Uint8Array(tarballBuffer).set(tarball);

    const form = new FormData();
    form.set(
      'tarball',
      new Blob([tarballBuffer], { type: 'application/octet-stream' }),
      stub.entry,
    );
    form.set('manifest', JSON.stringify(stub));

    process.stderr.write(
      `harness.dev publish: submitting ${stub.name}@${stub.version} (${stub.sizeBytes} bytes) to ${endpoint}...\n`,
    );

    const res = await fetch(endpoint, { method: 'POST', headers, body: form });
    if (!res.ok) {
      const body = await res.text();
      process.stderr.write(`harness.dev publish: HTTP ${res.status} ${res.statusText}\n${body}\n`);
      await cleanupTmpDir(packTmpDir);
      return 1;
    }

    const out = (await res.json()) as {
      name?: string;
      version?: string;
      tarballUrl?: string;
      manifestUrl?: string;
      integrity?: string;
      catalogSignedAt?: string;
    };

    process.stdout.write(`published ${out.name}@${out.version}\n`);
    if (out.tarballUrl) process.stdout.write(`  tarball:    ${out.tarballUrl}\n`);
    if (out.manifestUrl) process.stdout.write(`  manifest:   ${out.manifestUrl}\n`);
    if (out.integrity) process.stdout.write(`  integrity:  ${out.integrity}\n`);
    if (out.catalogSignedAt) process.stdout.write(`  catalog:    signedAt=${out.catalogSignedAt}\n`);

    await cleanupTmpDir(packTmpDir);
    return 0;
  },
};

/**
 * Run `npm pack --pack-destination <packTmpDir>` in `appDir`. Returns the
 * absolute path to the produced `.tgz`. Uses `child_process.spawn` rather
 * than the npm programmatic API so the CLI doesn't take a hard dependency
 * on a specific npm internal — the user's `npm` (whatever's in PATH) does
 * the packing.
 */
async function npmPack(appDir: string, packTmpDir: string): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const proc = spawn(
      'npm',
      ['pack', '--pack-destination', packTmpDir, '--json'],
      { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`npm pack exited ${code}\n${stderr.trim()}`));
        return;
      }
      try {
        // `npm pack --json` emits an array of `{ filename, ... }` records.
        const parsed = JSON.parse(stdout) as Array<{ filename?: string }>;
        if (!Array.isArray(parsed) || parsed.length === 0 || !parsed[0].filename) {
          reject(new Error(`npm pack --json output did not contain a filename: ${stdout.trim()}`));
          return;
        }
        resolvePromise(join(packTmpDir, parsed[0].filename));
      } catch (err) {
        reject(new Error(`failed to parse npm pack --json output: ${asMessage(err)}\n${stdout.trim()}`));
      }
    });
  });
}

async function cleanupTmpDir(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    // Best effort; the OS will clean tmpdir eventually.
  }
}

async function buildAuthHeaders(endpoint: string): Promise<Record<string, string>> {
  const id = process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (id && secret) {
    return { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret };
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      'Service Token env vars (CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET) not set, ' +
        'and stdin is not a TTY for interactive browser auth. ' +
        'Set the env vars for CI use, or run from a terminal session for interactive SSO.',
    );
  }

  const accessToken = await ensureFreshToken(endpoint);
  return { Authorization: `Bearer ${accessToken}` };
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
