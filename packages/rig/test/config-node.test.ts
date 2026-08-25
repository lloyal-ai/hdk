/**
 * Config-file mechanics (hdk#109) — the disk half of the substrate. Each
 * behavior here was review-hardened in lloyal-ai#14 and live-verified there;
 * these pin them: 0600 atomic writes that TIGHTEN a loose file, the writer's
 * version guard (never rebuild over an unusable file — ENOENT is the only
 * "fresh"), the loader's ignore-semantics, `git check-ignore` authority with
 * append-at-most-once, and boundary path resolution.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  resolvePath,
  resolveAppConfigPaths,
  readJsonOverlay,
  readJsonForWrite,
  writeJsonAtomic,
  maybeAppendGitignore,
} from '../src/config-node';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-config-node-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolvePath', () => {
  it('expands ~, resolves relative, passes absolute through; idempotent; "" stays ""', () => {
    expect(resolvePath('~')).toBe(os.homedir());
    expect(resolvePath('~/models/x.gguf')).toBe(path.join(os.homedir(), 'models/x.gguf'));
    expect(resolvePath('/abs/p')).toBe('/abs/p');
    expect(resolvePath('rel/p')).toBe(path.resolve('rel/p'));
    expect(resolvePath(resolvePath('~/a'))).toBe(resolvePath('~/a'));
    expect(resolvePath('')).toBe('');
  });
});

describe('resolveAppConfigPaths', () => {
  it('resolves *Path keys and ~/./-prefixed values; leaves the rest alone', () => {
    const out = resolveAppConfigPaths({
      corpusPath: '~/corpus',
      other: './x',
      key: 'tvly-secret',
      n: 3,
      empty: '',
    });
    expect(out.corpusPath).toBe(path.join(os.homedir(), 'corpus'));
    expect(out.other).toBe(path.resolve('./x'));
    expect(out.key).toBe('tvly-secret'); // non-path string untouched
    expect(out.n).toBe(3);
    expect(out.empty).toBe('');
  });
});

describe('readJsonOverlay (loader: ignorable)', () => {
  it('absent / corrupt / future-versioned all read as null; version 1 parses', () => {
    const p = path.join(dir, 'harness.json');
    expect(readJsonOverlay(p)).toBeNull();
    fs.writeFileSync(p, '{not json');
    expect(readJsonOverlay(p)).toBeNull();
    fs.writeFileSync(p, JSON.stringify({ version: 2, model: {} }));
    expect(readJsonOverlay(p)).toBeNull();
    fs.writeFileSync(p, JSON.stringify({ version: 1, model: { gpu: 'cuda' } }));
    expect(readJsonOverlay<{ model: { gpu: string } }>(p)?.model?.gpu).toBe('cuda');
  });
});

describe('readJsonForWrite (writer: never rebuild over unusable)', () => {
  it('ENOENT is the ONLY fresh config', () => {
    expect(readJsonForWrite(path.join(dir, 'absent.json'))).toBeNull();
  });
  it('not-JSON throws and names the file; nothing saved', () => {
    const p = path.join(dir, 'harness.json');
    fs.writeFileSync(p, '{oops');
    expect(() => readJsonForWrite(p)).toThrow(/harness\.json is not valid JSON.*nothing was saved/);
  });
  it("version ≠ 1 throws — a newer runtime's settings are not overwritten", () => {
    const p = path.join(dir, 'harness.json');
    const v2 = JSON.stringify({ version: 2, secret: 'keep-me' });
    fs.writeFileSync(p, v2);
    expect(() => readJsonForWrite(p)).toThrow(/version 2.*not overwriting a newer runtime/);
    expect(fs.readFileSync(p, 'utf8')).toBe(v2); // byte-identical
  });
  it.skipIf(process.getuid?.() === 0)('an unreadable file throws with its errno, not null', () => {
    const p = path.join(dir, 'harness.json');
    fs.writeFileSync(p, JSON.stringify({ version: 1 }));
    fs.chmodSync(p, 0o000);
    expect(() => readJsonForWrite(p)).toThrow(/cannot be read \(EACCES\).*nothing was saved/);
    fs.chmodSync(p, 0o600);
  });
});

describe('writeJsonAtomic', () => {
  it('creates the directory, writes 0600, leaves no tmp behind', () => {
    const p = path.join(dir, 'deep/nested/harness.json');
    writeJsonAtomic(p, { version: 1, a: 1 });
    expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toEqual({ version: 1, a: 1 });
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(p))).toEqual(['harness.json']);
  });
  it.skipIf(process.getuid?.() === 0)('TIGHTENS a previously loose file (rename carries the tmp mode)', () => {
    const p = path.join(dir, 'harness.json');
    fs.writeFileSync(p, '{}', { mode: 0o644 });
    fs.chmodSync(p, 0o644);
    writeJsonAtomic(p, { version: 1 });
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });
});

describe('maybeAppendGitignore', () => {
  const initRepo = () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
  };
  it('outside a git repo: false, no file created', () => {
    const p = path.join(dir, 'harness.json');
    expect(maybeAppendGitignore(p)).toBe(false);
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false);
  });
  it('appends at most once, as a repo-relative line', () => {
    initRepo();
    const p = path.join(dir, 'sub', 'harness.json');
    fs.mkdirSync(path.dirname(p));
    fs.writeFileSync(p, '{}');
    expect(maybeAppendGitignore(p)).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('sub/harness.json\n');
    expect(maybeAppendGitignore(p)).toBe(false); // second call: check-ignore says covered
  });
  it('git check-ignore is the authority — a wildcard already covering the file means no append', () => {
    initRepo();
    fs.writeFileSync(path.join(dir, '.gitignore'), '*.json\n');
    const p = path.join(dir, 'harness.json');
    fs.writeFileSync(p, '{}');
    expect(maybeAppendGitignore(p)).toBe(false);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('*.json\n');
  });
  it('a gitignore without a trailing newline gets one before the appended line', () => {
    initRepo();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules');
    const p = path.join(dir, 'harness.json');
    fs.writeFileSync(p, '{}');
    expect(maybeAppendGitignore(p)).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('node_modules\nharness.json\n');
  });
});
