/**
 * Tests for `harness-cli/src/commands/install.ts` + the shared
 * `verifyAndVendorApp` primitive — the verify → vendor-as-`file:` → `npm install`
 * → audit flow. npm never fetches a remote URL; the CLI verifies the signed
 * tarball itself and materializes it locally.
 *
 *   1. **Happy path** — catalog → manifest → tarball verify → write
 *      vendor/<flat>.tgz + manifest sidecar + `file:` dep → npm install (no URL)
 *      → audit clean → exit 0.
 *   2. **Manifest integrity mismatch** — `manifest.integrity` ≠ sha512(tarball
 *      bytes) → reject BEFORE anything is vendored or npm is invoked.
 *   3. **Lockfile integrity mismatch** — npm recorded a different integrity for
 *      the local tarball than we verified → rollback + exit 1.
 *   4. **Lockfile integrity absent** — some npm versions omit integrity for a
 *      `file:` dep; the Ed25519 sig + our sha512 already gate it → exit 0.
 *   5. **Lockfile entry missing** — npm didn't install the package → rollback.
 *   6. **Lockfile absent (ENOENT)** — reproducibility needs one → rollback.
 *
 * Network primitives (`fetchAndVerifyCatalog`, `fetchAndVerifyManifest`,
 * `verifyBundle`, `sha512Integrity`) are mocked; the tarball `fetch` is stubbed;
 * `npm` is stubbed (each test pre-seeds the lockfile to drive the audit branch).
 *
 * @category Testing
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

// ── Hoisted mocks ───────────────────────────────────────────────

const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

vi.mock('../src/verify', async (importActual) => {
  // Keep the real classes so `instanceof BundleVerificationError` still works.
  // Stub the network primitives + sha512Integrity per test.
  const actual = (await importActual()) as object;
  return {
    ...actual,
    fetchAndVerifyCatalog: vi.fn(),
    resolveAppVersion: vi.fn(),
    fetchAndVerifyManifest: vi.fn(),
    verifyBundle: vi.fn(),
    sha512Integrity: vi.fn(),
  };
});

import { installCommand } from '../src/commands/install';
import { verifyAndVendorApp, parseAppSpec } from '../src/scaffold/vendor-app';
import * as verify from '../src/verify';

// ── Test scaffolding ─────────────────────────────────────────────

const TARBALL_URL = 'https://apps.lloyal.ai/v1/bundles/lloyal__wikipedia-1.0.0.tgz';
const MANIFEST_URL = 'https://apps.lloyal.ai/v1/bundles/lloyal__wikipedia-1.0.0.manifest.json';
const IMPORT_NAME = '@lloyal-labs/wikipedia-app';
const SCOPED_NAME = 'lloyal/wikipedia';
const VERSION = '1.0.0';
const TARBALL_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]); // gzip-magic stub
const EXPECTED_INTEGRITY = 'sha512-abcdef==';
const VENDOR_REL = 'vendor/lloyal__wikipedia-1.0.0.tgz';
const FILE_DEP = `file:${VENDOR_REL}`;

let cwd: string;
let realCwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'harness-install-test-'));
  realCwd = process.cwd();
  process.chdir(cwd);

  // Stub global fetch for the tarball download leg. The catalog + manifest
  // fetches go through the mocked verify helpers above.
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => TARBALL_BYTES.buffer.slice(
      TARBALL_BYTES.byteOffset,
      TARBALL_BYTES.byteOffset + TARBALL_BYTES.byteLength,
    ),
  })));

  // Default mock returns for the network leg. Individual tests override.
  vi.mocked(verify.fetchAndVerifyCatalog).mockResolvedValue({} as never);
  vi.mocked(verify.resolveAppVersion).mockReturnValue({
    version: VERSION,
    manifestUrl: MANIFEST_URL,
    tarballUrl: TARBALL_URL,
    appProtocolVersion: '3.0',
    sizeBytes: TARBALL_BYTES.byteLength,
    importName: IMPORT_NAME,
  });
  vi.mocked(verify.fetchAndVerifyManifest).mockResolvedValue({
    manifest: {
      name: SCOPED_NAME,
      version: VERSION,
      entry: 'lloyal__wikipedia-1.0.0.tgz',
      signature: 'stub-sig',
      integrity: EXPECTED_INTEGRITY,
      publisherKeyId: 'lloyal-platform-2026-q2',
      sizeBytes: TARBALL_BYTES.byteLength,
    },
    trustKey: new Uint8Array(32),
  });
  vi.mocked(verify.verifyBundle).mockResolvedValue(true);
  vi.mocked(verify.sha512Integrity).mockResolvedValue(EXPECTED_INTEGRITY);
});

afterEach(async () => {
  process.chdir(realCwd);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mockSpawn.mockReset();
  await rm(cwd, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Stub `spawn('npm', [...])` so it doesn't shell out. The fake process emits
 * `close` with the given exit code on next tick. Tests separately pre-seed the
 * cwd lockfile so the audit reads the shape under test (npm itself never runs).
 */
function spawnReturning(code: number): EventEmitter {
  const fake = new EventEmitter() as EventEmitter & { stdout?: unknown; stderr?: unknown };
  setImmediate(() => fake.emit('close', code));
  return fake;
}

function recordedNpmCalls(): readonly string[][] {
  return mockSpawn.mock.calls.map((call: readonly unknown[]) => call[1] as string[]);
}

async function exists(rel: string): Promise<boolean> {
  return stat(join(cwd, rel)).then(() => true, () => false);
}

interface LockEntryShape {
  resolved?: string;
  integrity?: string | null; // null → write the entry WITHOUT an integrity field
  version?: string;
}

/**
 * Write `package.json` (no app dep — `verifyAndVendorApp` adds it) and,
 * optionally, a `package-lock.json` fixture standing in for what npm would write.
 */
async function seedProject(opts: {
  lockEntry?: LockEntryShape | null; // null → lockfile without the entry
  noLockfile?: boolean;              // true → skip writing package-lock.json
} = {}): Promise<void> {
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'install-smoke', version: '0.0.1' }, null, 2),
  );
  if (opts.noLockfile) return;
  const packages: Record<string, LockEntryShape | object> = { '': {} };
  if (opts.lockEntry !== null) {
    const entry: LockEntryShape = {
      resolved: opts.lockEntry?.resolved ?? FILE_DEP,
      version: opts.lockEntry?.version ?? VERSION,
    };
    // integrity: default present + matching; `null` omits it (file: dep case).
    if (opts.lockEntry?.integrity !== null) {
      entry.integrity = opts.lockEntry?.integrity ?? EXPECTED_INTEGRITY;
    }
    packages[`node_modules/${IMPORT_NAME}`] = entry;
  }
  await writeFile(
    join(cwd, 'package-lock.json'),
    JSON.stringify({ name: 'install-smoke', lockfileVersion: 3, packages }, null, 2),
  );
}

async function depSpec(): Promise<string | undefined> {
  const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8')) as {
    dependencies?: Record<string, string>;
  };
  return pkg.dependencies?.[IMPORT_NAME];
}

// ── verifyAndVendorApp ───────────────────────────────────────────

describe('verifyAndVendorApp', () => {
  it('verifies then writes vendor/<flat>.tgz + manifest sidecar + a file: dep', async () => {
    await seedProject();
    const out = await verifyAndVendorApp(cwd, parseAppSpec(SCOPED_NAME), { disclose: false });

    expect(out.importName).toBe(IMPORT_NAME);
    expect(out.vendorRelPath).toBe(VENDOR_REL);
    expect(out.integrity).toBe(EXPECTED_INTEGRITY);
    expect(await exists(VENDOR_REL)).toBe(true);
    expect(await exists('vendor/lloyal__wikipedia-1.0.0.manifest.json')).toBe(true);
    expect(await depSpec()).toBe(FILE_DEP);
    // No remote URL was handed to any installer — this function only writes files.
    expect(recordedNpmCalls().length).toBe(0);
  });

  it('throws on manifest integrity mismatch WITHOUT vendoring', async () => {
    await seedProject();
    vi.mocked(verify.sha512Integrity).mockResolvedValue('sha512-DIFFERENT==');

    await expect(verifyAndVendorApp(cwd, parseAppSpec(SCOPED_NAME))).rejects.toThrow();
    expect(await exists(VENDOR_REL)).toBe(false);
    expect(await depSpec()).toBeUndefined();
  });

  it('rejects a malformed spec at parse time', () => {
    expect(() => parseAppSpec('Not/AValidName!')).toThrow();
    expect(parseAppSpec('lloyal/web@^1.0.0')).toEqual({ name: 'lloyal/web', semver: '^1.0.0' });
  });
});

// ── installCommand ───────────────────────────────────────────────

describe('installCommand', () => {
  it('happy path: verify → vendor → npm install (no URL) → audit clean → exit 0', async () => {
    mockSpawn.mockImplementation(() => spawnReturning(0));
    await seedProject();

    const code = await installCommand.run([SCOPED_NAME]);

    expect(code).toBe(0);
    const calls = recordedNpmCalls();
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(['install', '--ignore-scripts']);
    // npm was NEVER handed the remote tarball URL.
    expect(calls[0]).not.toContain(TARBALL_URL);
    // The verified bytes were vendored locally and wired as a file: dep.
    expect(await exists(VENDOR_REL)).toBe(true);
    expect(await depSpec()).toBe(FILE_DEP);
  });

  it('--allow-scripts drops --ignore-scripts', async () => {
    mockSpawn.mockImplementation(() => spawnReturning(0));
    await seedProject();

    const code = await installCommand.run(['--allow-scripts', SCOPED_NAME]);

    expect(code).toBe(0);
    expect(recordedNpmCalls()[0]).toEqual(['install']);
  });

  it('manifest integrity mismatch: rejects BEFORE npm install + before vendoring', async () => {
    vi.mocked(verify.sha512Integrity).mockResolvedValue('sha512-DIFFERENT==');
    await seedProject();

    const code = await installCommand.run([SCOPED_NAME]);

    expect(code).toBe(1);
    expect(recordedNpmCalls().length).toBe(0); // npm never invoked
    expect(await exists(VENDOR_REL)).toBe(false); // nothing vendored
  });

  it('lockfile integrity mismatch: rollback + exit 1', async () => {
    mockSpawn.mockImplementation(() => spawnReturning(0));
    await seedProject({ lockEntry: { integrity: 'sha512-DIFFERENT==' } });

    const code = await installCommand.run([SCOPED_NAME]);

    expect(code).toBe(1);
    expect(recordedNpmCalls().map((c) => c[0])).toEqual(['install', 'uninstall']);
  });

  it('lockfile integrity absent (file: dep): accepted → exit 0', async () => {
    // npm may omit integrity for a local `file:` tarball; the Ed25519 signature +
    // our own pre-install sha512 already gate the bytes, so this is not a failure.
    mockSpawn.mockImplementation(() => spawnReturning(0));
    await seedProject({ lockEntry: { integrity: null } });

    const code = await installCommand.run([SCOPED_NAME]);

    expect(code).toBe(0);
    expect(recordedNpmCalls().map((c) => c[0])).toEqual(['install']);
  });

  it('lockfile entry missing: rollback + exit 1', async () => {
    mockSpawn.mockImplementation(() => spawnReturning(0));
    await seedProject({ lockEntry: null });

    const code = await installCommand.run([SCOPED_NAME]);

    expect(code).toBe(1);
    expect(recordedNpmCalls().map((c) => c[0])).toEqual(['install', 'uninstall']);
  });

  it('lockfile absent (ENOENT): rollback + exit 1 with lockfile-required message', async () => {
    mockSpawn.mockImplementation(() => spawnReturning(0));
    await seedProject({ noLockfile: true });

    const code = await installCommand.run([SCOPED_NAME]);

    expect(code).toBe(1);
    expect(recordedNpmCalls().map((c) => c[0])).toEqual(['install', 'uninstall']);
  });

  it('invalid app name: exit 1, nothing invoked', async () => {
    const code = await installCommand.run(['Not/AValidName!']);
    expect(code).toBe(1);
    expect(recordedNpmCalls().length).toBe(0);
  });
});
