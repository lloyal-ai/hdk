/**
 * Tests for `harness-cli/src/commands/install.ts` — the install path's
 * post-`npm install` audit gate. Five cases exercise the invariants the
 * PR promises (and which previously failed silently):
 *
 *   1. **Happy path** — catalog → manifest → tarball verify → npm install
 *      → audit clean → exit 0.
 *   2. **Manifest integrity mismatch** — `manifest.integrity` ≠
 *      sha512(tarball bytes) → reject BEFORE shelling out to npm. Loud
 *      signing-pipeline-bug error.
 *   3. **Lockfile integrity mismatch** — npm wrote a different integrity
 *      than we computed pre-install → rollback + exit 1.
 *   4. **Lockfile `resolved` mismatch** — npm recorded a non-canonical
 *      `resolved` URL → CI can't reproduce → rollback + exit 1.
 *   5. **Lockfile entry missing** — npm install didn't write the
 *      expected `node_modules/<importName>` entry → throw → rollback +
 *      exit 1.
 *
 * Network primitives (`fetchAndVerifyCatalog`, `fetchAndVerifyManifest`,
 * `verifyBundle`) are mocked. The tarball fetch + npm shell-out are
 * stubbed so each test pre-seeds the cwd lockfile to drive the audit
 * branch under test. Real `npm install` is not invoked.
 *
 * @category Testing
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

// ── Hoisted mocks ───────────────────────────────────────────────

const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

vi.mock('../src/verify', async (importActual) => {
  // Keep the real class so `instanceof BundleVerificationError` still works
  // in install.ts. Stub the network primitives + sha512Integrity per test.
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
import * as verify from '../src/verify';

// ── Test scaffolding ─────────────────────────────────────────────

const TARBALL_URL = 'https://apps.lloyal.ai/v1/bundles/lloyal__wikipedia-1.0.0.tgz';
const IMPORT_NAME = '@lloyal-labs/wikipedia-app';
const SCOPED_NAME = 'lloyal/wikipedia';
const VERSION = '1.0.0';
const TARBALL_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]); // gzip-magic stub
const EXPECTED_INTEGRITY = 'sha512-abcdef==';

let cwd: string;
let realCwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'harness-install-test-'));
  realCwd = process.cwd();
  process.chdir(cwd);

  // Stub global fetch for the tarball download leg. The catalog +
  // manifest fetches go through the mocked verify helpers above.
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
    manifestUrl: 'https://apps.lloyal.ai/v1/bundles/lloyal__wikipedia-1.0.0.manifest.json',
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

// ── Spawn helper ────────────────────────────────────────────────

/**
 * Stub `spawn('npm', [...])` so it doesn't shell out. The fake process
 * emits `close` with the given exit code on next tick. Tests separately
 * pre-seed the cwd lockfile/package.json so the audit reads the shape
 * under test (npm itself doesn't actually run).
 */
function spawnReturning(code: number): EventEmitter {
  const fake = new EventEmitter() as EventEmitter & { stdout?: unknown; stderr?: unknown };
  setImmediate(() => fake.emit('close', code));
  return fake;
}

function recordedNpmCalls(): readonly string[][] {
  return mockSpawn.mock.calls.map((call: readonly unknown[]) => call[1] as string[]);
}

// ── Lockfile fixtures ───────────────────────────────────────────

interface LockEntryShape {
  resolved?: string;
  integrity?: string;
  version?: string;
}

async function seedProject(opts: {
  lockEntry?: LockEntryShape | null; // null → write lockfile without the entry
  depSpec?: string | null;           // null → omit dep entirely
  noLockfile?: boolean;              // true → skip writing package-lock.json
}): Promise<void> {
  if (!opts.noLockfile) {
    const packages: Record<string, LockEntryShape | object> = { '': {} };
    if (opts.lockEntry !== null) {
      packages[`node_modules/${IMPORT_NAME}`] = {
        resolved: opts.lockEntry?.resolved ?? TARBALL_URL,
        integrity: opts.lockEntry?.integrity ?? EXPECTED_INTEGRITY,
        version: opts.lockEntry?.version ?? VERSION,
      };
    }
    const lockfile = { name: 'install-smoke', lockfileVersion: 3, packages };
    await writeFile(join(cwd, 'package-lock.json'), JSON.stringify(lockfile, null, 2));
  }
  const pkg: { name: string; version: string; dependencies?: Record<string, string> } = {
    name: 'install-smoke',
    version: '0.0.1',
  };
  if (opts.depSpec !== null) {
    pkg.dependencies = { [IMPORT_NAME]: opts.depSpec ?? TARBALL_URL };
  }
  await writeFile(join(cwd, 'package.json'), JSON.stringify(pkg, null, 2));
}

// ── Tests ───────────────────────────────────────────────────────

describe('installCommand audit gate', () => {
  it('happy path: all invariants satisfied → exit 0, one npm install, no uninstall', async () => {
    mockSpawn.mockImplementation(() => spawnReturning(0));
    await seedProject({});

    const code = await installCommand.run([SCOPED_NAME]);

    expect(code).toBe(0);
    const calls = recordedNpmCalls();
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe('install');
    expect(calls[0]).toContain(TARBALL_URL);
  });

  it('manifest integrity mismatch: rejects BEFORE npm install runs', async () => {
    // Worker emitted manifest.integrity ≠ sha512(tarball bytes). The Ed25519
    // sig still verifies (we mock verifyBundle → true) — this guards a
    // signing-pipeline bug specifically.
    vi.mocked(verify.sha512Integrity).mockResolvedValue('sha512-DIFFERENT==');

    const code = await installCommand.run([SCOPED_NAME]);

    expect(code).toBe(1);
    expect(recordedNpmCalls().length).toBe(0); // npm never invoked
  });

  it('lockfile integrity mismatch: rollback + exit 1', async () => {
    mockSpawn.mockImplementation(() => spawnReturning(0));
    await seedProject({ lockEntry: { integrity: 'sha512-DIFFERENT==' } });

    const code = await installCommand.run([SCOPED_NAME]);

    expect(code).toBe(1);
    const calls = recordedNpmCalls();
    expect(calls.map((c) => c[0])).toEqual(['install', 'uninstall']);
  });

  it('lockfile resolved mismatch: rollback + exit 1', async () => {
    mockSpawn.mockImplementation(() => spawnReturning(0));
    await seedProject({
      lockEntry: { resolved: 'https://attacker.example/x.tgz' },
    });

    const code = await installCommand.run([SCOPED_NAME]);

    expect(code).toBe(1);
    expect(recordedNpmCalls().map((c) => c[0])).toEqual(['install', 'uninstall']);
  });

  it('lockfile entry missing: rollback + exit 1', async () => {
    mockSpawn.mockImplementation(() => spawnReturning(0));
    await seedProject({ lockEntry: null });

    const code = await installCommand.run([SCOPED_NAME]);

    expect(code).toBe(1);
    expect(recordedNpmCalls().map((c) => c[0])).toEqual(['install', 'uninstall']);
  });

  it('package.json missing dep spec: rollback + exit 1', async () => {
    mockSpawn.mockImplementation(() => spawnReturning(0));
    await seedProject({ depSpec: null });

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
});
