/**
 * A packaged app has no project directory: its own files are read-only inside the bundle, and
 * everything a run produces has to go somewhere writable. The manifest is the one file that belongs
 * to both worlds — it ships as the application's default and becomes the installation's own — so a
 * first launch copies it across, once.
 *
 * Only the copy is tested here; deciding the locations reads Electron and is a handful of lines over
 * `app.isPackaged`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedIfAbsent, SeedFailed } from '../src/placement';

const made: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'placement-'));
  made.push(d);
  return d;
};
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('seedIfAbsent', () => {
  it('gives a fresh installation the application default', () => {
    const from = path.join(tmp(), 'harness.yml');
    fs.writeFileSync(from, 'model:\n  llm: { id: qwen3.5-4b }\n');
    const to = path.join(tmp(), 'harness.yml');
    expect(seedIfAbsent(from, to)).toBe('seeded');
    expect(fs.readFileSync(to, 'utf8')).toBe('model:\n  llm: { id: qwen3.5-4b }\n');
  });

  it('never overwrites what the installation now owns — the reader\'s edits outlive an update', () => {
    const from = path.join(tmp(), 'harness.yml');
    fs.writeFileSync(from, 'shipped\n');
    const to = path.join(tmp(), 'harness.yml');
    fs.writeFileSync(to, 'theirs\n');
    expect(seedIfAbsent(from, to)).toBe('present');
    expect(fs.readFileSync(to, 'utf8')).toBe('theirs\n');
  });

  it('creates the root when nothing is there yet', () => {
    const from = path.join(tmp(), 'harness.yml');
    fs.writeFileSync(from, 'shipped\n');
    const root = path.join(tmp(), 'deep', 'nested');
    expect(seedIfAbsent(from, path.join(root, 'harness.yml'))).toBe('seeded');
    expect(fs.existsSync(path.join(root, 'harness.yml'))).toBe(true);
  });

  it('lands whole or not at all: an interrupted first launch leaves no half-written manifest for the next one to trust', () => {
    const from = path.join(tmp(), 'harness.yml');
    fs.writeFileSync(from, 'shipped\n');
    const dir = tmp();
    const to = path.join(dir, 'harness.yml');
    // A directory where the file goes: the rename cannot land, and nothing partial may remain.
    fs.mkdirSync(to);
    expect(() => seedIfAbsent(from, to)).toThrow(SeedFailed);
    expect(fs.readdirSync(dir).filter((f) => f !== 'harness.yml')).toEqual([]);
  });

  it('says which file it could not read when the application default is missing', () => {
    const to = path.join(tmp(), 'harness.yml');
    const from = path.join(tmp(), 'harness.yml');
    expect(() => seedIfAbsent(from, to)).toThrow(SeedFailed);
    try { seedIfAbsent(from, to); } catch (e) { expect(String(e)).toContain(from); }
  });
});
