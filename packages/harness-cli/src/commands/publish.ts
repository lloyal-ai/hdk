import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import type { Command } from '../command';
import { ensureFreshToken } from '../cf-access-oauth';
import { buildAttentionSurface } from '../describe';
import { readTarEntry } from '../tar-read';

const API_BASE = 'https://api.lloyal.ai';
const DEFAULT_PUBLISH_ENDPOINT = `${API_BASE}/v1/publish`;
const DEFAULT_PUBLISHERS_ME_ENDPOINT = `${API_BASE}/v1/publishers/me`;
const DEFAULT_SUBMISSION_ENDPOINT_BASE = `${API_BASE}/v1/submissions`;

const USAGE = [
  'harness.dev publish — submit an HDK app to apps.lloyal.ai for review + signing',
  '',
  'Usage:',
  '  npx harness.dev publish [--dir <path>] [--endpoint <url>]',
  '  npx harness.dev publish status <submissionId>',
  '',
  'Options:',
  '  --dir <path>      App directory (default: cwd)',
  '  --endpoint <url>  Override the publish endpoint (default: ' + DEFAULT_PUBLISH_ENDPOINT + ')',
  '  -h, --help        Show this help',
  '',
  'Flow:',
  '  1. Look up the authenticated publisher via GET /v1/publishers/me to obtain',
  '     the registered handle. If no record exists, the CLI errors with a pointer',
  '     to `harness.dev publishers register`.',
  '  2. Read app.json + package.json. The catalog `name` is built as',
  '     `<publisher-handle>/<app.json.name>` (auto-prefixed); the npm package',
  '     name from package.json flows through as `importName`. If app.json already',
  '     carries a scoped name, the publisher prefix must match.',
  '  3. Run `npm pack` in the app directory.',
  '  4. POST the .tgz bytes + manifest stub to the publish endpoint. The submission',
  '     enters the quarantine queue (status `pending`) — Lloyal review approves or',
  '     rejects; only on approval does the artifact get signed + cataloged.',
  '',
  'Auth: same Cloudflare Access OAuth flow as the rest of the CLI.',
  '  Service Token (CI): CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET env vars.',
  '  Interactive (dev):  Opens a browser for SSO on first run. Caches the token at',
  '                      $XDG_CACHE_HOME/lloyal/auth.json (default ~/.cache/lloyal/',
  '                      auth.json), mode 0600. Subsequent publishes are silent',
  '                      until the grant expires.',
  '',
  '`harness.dev publish status <id>` polls /v1/submissions/<id> for the current',
  'review state of a previously submitted submission.',
].join('\n');

interface AppJson {
  name: string;
  appProtocolVersion?: string;
  protocol?: { name?: string; useWhen?: string; tools?: string[] };
}

interface PackageJson {
  name: string;
  version: string;
  main?: string;
  peerDependencies?: Record<string, string>;
}

interface ManifestStub {
  /** Scoped catalog name `<publisher-handle>/<short-name>`. */
  name: string;
  version: string;
  /** Tarball filename. Cosmetic — the Worker computes canonical paths server-side. */
  entry: string;
  /**
   * npm package name from the tarball's package.json. The Worker
   * cross-checks this against the actual extracted package.json.name and
   * rejects mismatches with `importName-mismatch`.
   */
  importName: string;
  sizeBytes: number;
  peerDependencies?: Record<string, string>;
}

interface PublisherMeResponse {
  handle?: string;
  status?: 'active' | 'suspended';
  error?: string;
  registerUrl?: string;
}

const SCOPED_NAME_PATTERN =
  /^([a-z][a-z0-9_-]{1,63})\/([a-z][a-z0-9_-]{1,63})$/;
const UNSCOPED_NAME_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

export const publishCommand: Command = {
  name: 'publish',
  summary: 'Submit an HDK app to apps.lloyal.ai for review + signing',
  usage: USAGE,
  async run(argv) {
    // `publish status <id>` is a sub-verb; it has different argv shape.
    if (argv[0] === 'status') {
      return runStatus(argv.slice(1));
    }

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
    const endpoint = values.endpoint ?? DEFAULT_PUBLISH_ENDPOINT;

    // Read app.json for protocol metadata + manifest name/version.
    let appJson: AppJson;
    try {
      const raw = await readFile(join(appDir, 'app.json'), 'utf-8');
      appJson = JSON.parse(raw) as AppJson;
    } catch (err) {
      process.stderr.write(`harness.dev publish: cannot read ${join(appDir, 'app.json')}: ${asMessage(err)}\n`);
      return 1;
    }

    if (typeof appJson.name !== 'string') {
      process.stderr.write(`harness.dev publish: app.json "name" is not a string\n`);
      return 1;
    }
    if (
      !SCOPED_NAME_PATTERN.test(appJson.name) &&
      !UNSCOPED_NAME_PATTERN.test(appJson.name)
    ) {
      process.stderr.write(
        `harness.dev publish: invalid app.json "name" — expected ` +
          '`<short-name>` or `<publisher>/<short-name>` matching `[a-z][a-z0-9_-]{1,63}`.\n',
      );
      return 1;
    }

    // Read package.json for peerDependencies + npm package name —
    // peerDependencies need to flow into the catalog manifest so
    // consumers can see them pre-install, and `package.json.name` is the
    // npm identifier the consumer `import`s from (`importName`).
    let packageJson: PackageJson;
    try {
      const raw = await readFile(join(appDir, 'package.json'), 'utf-8');
      packageJson = JSON.parse(raw) as PackageJson;
    } catch (err) {
      process.stderr.write(`harness.dev publish: cannot read ${join(appDir, 'package.json')}: ${asMessage(err)}\n`);
      return 1;
    }
    if (typeof packageJson.name !== 'string' || packageJson.name.length === 0) {
      process.stderr.write(
        `harness.dev publish: package.json "name" missing — needed to carry through as importName\n`,
      );
      return 1;
    }
    if (
      typeof packageJson.version !== 'string' ||
      !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(packageJson.version)
    ) {
      process.stderr.write(
        `harness.dev publish: invalid package.json "version" (expected semver) — this is the catalog version published as <name>@<version>\n`,
      );
      return 1;
    }

    // Resolve auth + look up the publisher handle. The Worker would
    // reject an unauthenticated/unregistered publish anyway, but doing
    // the handle lookup client-side lets us auto-prefix the catalog
    // name before the multipart submission and surface a clearer error.
    let headers: Record<string, string>;
    try {
      headers = await buildAuthHeaders(endpoint);
    } catch (err) {
      process.stderr.write(`harness.dev publish: ${asMessage(err)}\n`);
      return 1;
    }

    let publisherHandle: string;
    try {
      publisherHandle = await lookupPublisherHandle(headers);
    } catch (err) {
      process.stderr.write(`harness.dev publish: ${asMessage(err)}\n`);
      return 1;
    }

    // Build the catalog `name`: scoped form `<handle>/<short>`. If
    // app.json already carries a scoped name, the publisher prefix
    // must match — we won't silently rewrite to a different handle.
    const scopedNameMatch = appJson.name.match(SCOPED_NAME_PATTERN);
    let catalogName: string;
    if (scopedNameMatch) {
      if (scopedNameMatch[1] !== publisherHandle) {
        process.stderr.write(
          `harness.dev publish: app.json "name" is scoped under "${scopedNameMatch[1]}" ` +
            `but you're registered as "${publisherHandle}". Either change app.json ` +
            `to "${publisherHandle}/${scopedNameMatch[2]}" or drop the prefix.\n`,
        );
        return 1;
      }
      catalogName = appJson.name;
    } else {
      catalogName = `${publisherHandle}/${appJson.name}`;
    }

    // Serialize the app's ATTENTION SURFACE (skill prose + full tool schemas +
    // useWhen + configSchema) into `attention-surface.json` in the app dir, so
    // `npm pack` includes it and it's covered by the signed tarball. Written
    // before pack; removed on EVERY exit — the build-failure catch right here
    // and the pack block's `finally` below.
    const surfacePath = join(appDir, 'attention-surface.json');
    try {
      const surface = await buildAttentionSurface(appDir, appJson, packageJson);
      await writeFile(surfacePath, `${JSON.stringify(surface, null, 2)}\n`);
    } catch (err) {
      process.stderr.write(`harness.dev publish: could not build attention surface: ${asMessage(err)}\n`);
      await rm(surfacePath, { force: true }).catch(() => {});
      return 1;
    }

    // Build the tarball via `npm pack` shell-out, then assert the surface landed.
    // The tarball bytes are read fully into memory, so both transient artifacts —
    // the source-tree `attention-surface.json` and the pack temp dir — are cleaned
    // in `finally`, regardless of success or the early-return below. Nothing
    // downstream reads either, so a failed pack can't leak a temp dir.
    let packTmpDir: string | undefined;
    let tarball: Uint8Array;
    try {
      packTmpDir = await mkdtemp(join(tmpdir(), 'harness-dev-publish-'));
      const tarballPath = await npmPack(appDir, packTmpDir);
      tarball = new Uint8Array(await readFile(tarballPath));
    } catch (err) {
      process.stderr.write(`harness.dev publish: npm pack failed: ${asMessage(err)}\n`);
      return 1;
    } finally {
      await rm(surfacePath, { force: true }).catch(() => {});
      if (packTmpDir) await cleanupTmpDir(packTmpDir);
    }

    // GUARD: a missing `files` whitelist entry would silently ship a
    // surface-less tarball. Fail LOUD here on the publisher's machine.
    if ((await readTarEntry(tarball, 'package/attention-surface.json')) === null) {
      process.stderr.write(
        'harness.dev publish: attention-surface.json was generated but did NOT land in the ' +
          'tarball. Add "attention-surface.json" to your package.json "files" array.\n',
      );
      return 1;
    }

    const flatName = catalogName.replace('/', '__');
    const stub: ManifestStub = {
      name: catalogName,
      version: packageJson.version,
      entry: `${flatName}-${packageJson.version}.tgz`,
      importName: packageJson.name,
      sizeBytes: tarball.byteLength,
      peerDependencies: packageJson.peerDependencies,
    };

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
      return 1;
    }

    const out = (await res.json()) as {
      submissionId?: string;
      status?: string;
      name?: string;
      version?: string;
      importName?: string;
      submittedAt?: string;
      statusUrl?: string;
    };

    process.stdout.write(
      `submitted ${out.name ?? catalogName}@${out.version ?? packageJson.version} for review\n`,
    );
    if (out.submissionId) process.stdout.write(`  submission: ${out.submissionId}\n`);
    if (out.status) process.stdout.write(`  status:     ${out.status}\n`);
    if (out.importName) process.stdout.write(`  import:     ${out.importName}\n`);
    if (out.submittedAt) process.stdout.write(`  submitted:  ${out.submittedAt}\n`);
    if (out.statusUrl) process.stdout.write(`  poll:       harness.dev publish status ${out.submissionId ?? '<id>'}\n`);

    return 0;
  },
};

/**
 * `harness.dev publish status <submissionId>` — poll the submission's
 * current review state. Used by publishers to see whether their pending
 * submission has been approved or rejected.
 */
async function runStatus(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (positionals.length !== 1) {
    process.stderr.write('harness.dev publish status: expected exactly one <submissionId> argument\n');
    return 1;
  }
  const submissionId = positionals[0];
  if (!/^[0-9a-f-]+$/i.test(submissionId)) {
    process.stderr.write(`harness.dev publish status: invalid submissionId "${submissionId}"\n`);
    return 1;
  }
  const endpoint = `${DEFAULT_SUBMISSION_ENDPOINT_BASE}/${submissionId}`;

  let headers: Record<string, string>;
  try {
    headers = await buildAuthHeaders(endpoint);
  } catch (err) {
    process.stderr.write(`harness.dev publish status: ${asMessage(err)}\n`);
    return 1;
  }
  const res = await fetch(endpoint, { headers });
  if (!res.ok) {
    const body = await res.text();
    process.stderr.write(`harness.dev publish status: HTTP ${res.status}\n${body}\n`);
    return 1;
  }
  const out = (await res.json()) as {
    submissionId?: string;
    status?: string;
    submittedAt?: string;
    approvedAt?: string;
    rejectedAt?: string;
    reviewerEmail?: string;
    rejectionReason?: string;
    tarballUrl?: string;
  };
  process.stdout.write(`${out.submissionId ?? submissionId}\n`);
  process.stdout.write(`  status:    ${out.status ?? 'unknown'}\n`);
  if (out.submittedAt) process.stdout.write(`  submitted: ${out.submittedAt}\n`);
  if (out.approvedAt) process.stdout.write(`  approved:  ${out.approvedAt}\n`);
  if (out.rejectedAt) process.stdout.write(`  rejected:  ${out.rejectedAt}\n`);
  if (out.reviewerEmail) process.stdout.write(`  reviewer:  ${out.reviewerEmail}\n`);
  if (out.rejectionReason) process.stdout.write(`  reason:    ${out.rejectionReason}\n`);
  if (out.tarballUrl) process.stdout.write(`  tarball:   ${out.tarballUrl}\n`);
  return 0;
}

/**
 * GET /v1/publishers/me — return the publisher handle for the
 * authenticated identity. Throws if no record exists (publisher needs
 * to `harness.dev publishers register` first) or if the account is
 * suspended.
 */
async function lookupPublisherHandle(
  headers: Record<string, string>,
): Promise<string> {
  const res = await fetch(DEFAULT_PUBLISHERS_ME_ENDPOINT, { headers });
  if (res.status === 404) {
    const body = (await res.json().catch(() => ({}))) as PublisherMeResponse;
    throw new Error(
      'no publisher account for this identity. Run `harness.dev publishers register --handle <handle>` first.' +
        (body.registerUrl ? `\n  register: ${body.registerUrl}` : ''),
    );
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET /v1/publishers/me returned HTTP ${res.status}\n${body}`);
  }
  const me = (await res.json()) as PublisherMeResponse;
  if (me.status === 'suspended') {
    throw new Error('publisher account is suspended — contact support@lloyal.ai');
  }
  if (typeof me.handle !== 'string' || me.handle.length === 0) {
    throw new Error('publisher record returned no handle');
  }
  return me.handle;
}

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
