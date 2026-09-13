/**
 * The library's folder mechanics, on their own: a name is minted and its folder
 * reserved in one exclusive step; which failures retry and which do not; how many
 * attempts; a client-supplied path is trusted only once its real location is a
 * regular file exactly one folder below the root; a listing applies the same rule
 * to every folder. Ported from casework's reservation and library tests; the
 * report format and the settled rule stay with the app.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RESERVE_ATTEMPTS, mintFolderName, reserveFolder, confined, listFolders, removeFolder } from '../src/folders';

const lib = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'folders-'));
const SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('mintFolderName', () => {
  it('is a sortable stamp, then a UUID; safe as a path segment and as a file name', () => {
    const id = mintFolderName(new Date('2026-03-01T12:34:56.789Z'));
    expect(id).toMatch(SHAPE);
    expect(id.startsWith('2026-03-01T12-34-56-789-')).toBe(true);
    expect(encodeURIComponent(id)).toBe(id);
    expect(path.basename(id)).toBe(id);
  });

  it('a thousand mints in one millisecond are a thousand names', () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    expect(new Set(Array.from({ length: 1000 }, () => mintFolderName(now))).size).toBe(1000);
  });
});

describe('reserveFolder', () => {
  it('creates the root if needed, and the folder exclusively', () => {
    const root = path.join(lib(), 'not', 'yet', 'there');
    const id = reserveFolder(root);
    expect(id).toMatch(SHAPE);
    expect(fs.statSync(path.join(root, id)).isDirectory()).toBe(true);
    expect(fs.readdirSync(path.join(root, id))).toEqual([]);
  });

  it('a collision retries with a fresh name and leaves the planted folder alone', () => {
    const root = lib();
    const dup = mintFolderName(new Date(0));
    fs.mkdirSync(path.join(root, dup));
    fs.writeFileSync(path.join(root, dup, 'report.md'), '# planted\n');
    const mint = vi.fn(() => (mint.mock.calls.length === 1 ? dup : mintFolderName(new Date(1))));
    const id = reserveFolder(root, { mint });
    expect(id).not.toBe(dup);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(path.join(root, dup))).toEqual(['report.md']);
    expect(fs.readdirSync(root).sort()).toEqual([dup, id].sort());
  });

  it('after the bound it refuses, having created nothing', () => {
    const root = lib();
    const dup = mintFolderName(new Date(0));
    fs.mkdirSync(path.join(root, dup));
    const mint = vi.fn(() => dup);
    expect(() => reserveFolder(root, { mint })).toThrow(new RegExp(`after ${RESERVE_ATTEMPTS} attempts`));
    expect(mint).toHaveBeenCalledTimes(RESERVE_ATTEMPTS);
    expect(fs.readdirSync(root)).toEqual([dup]);
    const two = vi.fn(() => dup);
    expect(() => reserveFolder(root, { mint: two, attempts: 2 })).toThrow(/after 2 attempts/);
    expect(two).toHaveBeenCalledTimes(2);
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'only EEXIST retries — any other failure is the root\'s and is thrown at once',
    () => {
      const root = path.join(lib(), 'library');
      fs.mkdirSync(root);
      fs.chmodSync(root, 0o500);
      try {
        const mint = vi.fn(() => mintFolderName(new Date(0)));
        expect(() => reserveFolder(root, { mint })).toThrow(expect.objectContaining({ code: 'EACCES' }));
        expect(mint).toHaveBeenCalledTimes(1);
      } finally {
        fs.chmodSync(root, 0o700);
      }
    },
  );

  it('the default mint is the real one, so a forced crypto collision is what a harness sees', () => {
    const root = lib();
    const dup = '0f0f0f0f-0000-4000-8000-00000000dead';
    const fresh = '0f0f0f0f-0000-4000-8000-0000000f0e5';
    const now = new Date('2026-03-01T12:00:00.000Z');
    vi.useFakeTimers({ now, toFake: ['Date'] });
    const real = webcrypto.randomUUID.bind(webcrypto);
    const uuids = [dup, dup, fresh];
    vi.spyOn(webcrypto, 'randomUUID').mockImplementation((() => uuids.shift() ?? real()) as typeof webcrypto.randomUUID);
    fs.mkdirSync(path.join(root, `${mintFolderName(now).slice(0, 24)}${dup}`));
    const id = reserveFolder(root);
    expect(id.endsWith(fresh)).toBe(true);
  });
});

describe('confined', () => {
  it('accepts a regular file exactly one folder below the root, by real path', () => {
    const root = lib();
    const run = path.join(root, 'a');
    fs.mkdirSync(run);
    fs.writeFileSync(path.join(run, 'report.md'), '# a\n');
    expect(confined(root, path.join(run, 'report.md'))).toBe(fs.realpathSync(path.join(run, 'report.md')));
    expect(confined(root, path.join(run, '..', 'a', 'report.md'))).toBe(fs.realpathSync(path.join(run, 'report.md')));
  });

  it('refuses the root itself, a root-level file, a deeper file, a folder, and a missing path', () => {
    const root = lib();
    fs.writeFileSync(path.join(root, 'report.md'), '# at the root\n');
    fs.mkdirSync(path.join(root, 'a', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'deep', 'report.md'), '# too deep\n');
    fs.mkdirSync(path.join(root, 'b', 'report.md'), { recursive: true });
    expect(confined(root, root)).toBeNull();
    expect(confined(root, path.join(root, 'report.md'))).toBeNull();
    expect(confined(root, path.join(root, 'a', 'deep', 'report.md'))).toBeNull();
    expect(confined(root, path.join(root, 'b', 'report.md'))).toBeNull();
    expect(confined(root, path.join(root, 'c', 'report.md'))).toBeNull();
  });

  it('refuses a symlink whose real location is outside the root, and a symlinked folder', () => {
    const root = lib();
    const outside = lib();
    fs.writeFileSync(path.join(outside, 'secret.md'), 'SECRET\n');
    fs.mkdirSync(path.join(root, 'a'));
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'a', 'report.md'));
    fs.symlinkSync(outside, path.join(root, 'evil'));
    expect(confined(root, path.join(root, 'a', 'report.md'))).toBeNull();
    expect(confined(root, path.join(root, 'evil', 'secret.md'))).toBeNull();
  });
});

describe('listFolders', () => {
  it('lists, by name, the folders whose marker is confined; an empty or missing root lists nothing', () => {
    const root = lib();
    const outside = lib();
    fs.writeFileSync(path.join(outside, 'report.md'), '# leaked\n');
    for (const name of ['2026-02', '2026-01']) {
      fs.mkdirSync(path.join(root, name));
      fs.writeFileSync(path.join(root, name, 'report.md'), `# ${name}\n`);
    }
    fs.mkdirSync(path.join(root, 'unfinished'));                       // reserved, no marker
    fs.symlinkSync(outside, path.join(root, 'linked'));                 // a symlinked folder
    fs.writeFileSync(path.join(root, 'stray.md'), 'not a folder\n');
    expect(listFolders(root, 'report.md')).toEqual([
      { name: '2026-01', path: fs.realpathSync(path.join(root, '2026-01', 'report.md')) },
      { name: '2026-02', path: fs.realpathSync(path.join(root, '2026-02', 'report.md')) },
    ]);
    expect(listFolders(path.join(root, 'missing'), 'report.md')).toEqual([]);
  });
});

describe('removeFolder', () => {
  it('removes the folder with everything in it; a missing folder is nothing to do', () => {
    const root = lib();
    const id = reserveFolder(root);
    fs.writeFileSync(path.join(root, id, 'annexure-1.md'), 'evidence\n');
    removeFolder(path.join(root, id));
    expect(fs.existsSync(path.join(root, id))).toBe(false);
    expect(() => removeFolder(path.join(root, 'never'))).not.toThrow();
  });
});
