/**
 * loadResources error contract — THROWS, never exits.
 *
 * Regression for the process.exit(1) sites (hdk#110): a bad corpus killed the
 * calling process — the cli, the desktop engine child, or an entire served
 * host (one tenant's bad config exited every session) — before any catch
 * could run. Every call site already wraps enable in try/catch; these tests
 * pin the contract that makes those catches reachable.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadResources } from '../src/resources';

describe('loadResources error contract (throws, never exits)', () => {
  it('nonexistent path → throws corpus-not-found', () => {
    expect(() => loadResources('/nonexistent-corpus-xyz')).toThrow(/corpus not found/);
  });

  it('existing dir with no markdown → throws no-matches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-empty-'));
    writeFileSync(join(dir, 'notes.txt'), 'not markdown');
    expect(() => loadResources(dir)).toThrow(/no \.md\(x\) files matched/);
  });

  it('non-markdown file → throws unsupported', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-file-'));
    const f = join(dir, 'doc.txt');
    writeFileSync(f, 'text');
    expect(() => loadResources(f)).toThrow(/only \.md\/\.mdx files are supported/);
  });

  it('glob with a non-markdown tail → throws unsupported pattern', () => {
    expect(() => loadResources('/tmp/*.txt')).toThrow(/only \.md\/\.mdx files are supported/);
  });

  it('valid corpus still loads (happy path unchanged)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-ok-'));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'a.md'), '# A');
    writeFileSync(join(dir, 'sub', 'b.mdx'), '# B');
    const res = loadResources(dir);
    expect(res.map((r) => r.name).sort()).toEqual(['a.md', 'sub/b.mdx']);
  });
});
