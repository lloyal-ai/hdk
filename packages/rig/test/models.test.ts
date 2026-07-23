/**
 * Tests for the verified, project-local model resolver ({@link resolveModel})
 * and the streaming digest-verified download ({@link fetchVerified}).
 *
 * Behaviours verified:
 *  1. `path:` resolution (as-is, no copy) + missing-path error.
 *  2. `id:` with an existing slot → used without a fetch.
 *  3. No-spec adoption: sole `.gguf` adopted; `>1` → ambiguous error; empty → clear error.
 *  4. Path-traversal guard on `id`/`role` (no escape from `models/`).
 *  5. `fetchVerified`: digest match writes the slot; **digest mismatch deletes the
 *     `.partial` and throws** (nothing written); URL fallback; all-fail aggregation.
 *
 * @category Testing
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  resolveModel,
  fetchVerified,
  type ModelCatalogEntry,
  type ModelRole,
} from '../src/models';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-models-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function put(rel: string, content = 'x'): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** A `fetch` stub: each url maps to bytes (200 OK) or an Error (thrown). */
function mockFetch(map: Record<string, Uint8Array | Error>): typeof fetch {
  return (async (input: unknown): Promise<Response> => {
    const url = String(input);
    const v = map[url];
    if (v instanceof Error) throw v;
    if (v === undefined) throw new Error(`no mock for ${url}`);
    return new Response(v);
  }) as unknown as typeof fetch;
}

describe('resolveModel — filesystem walk', () => {
  it('explicit path: resolves absolute, no copy', async () => {
    put('weights/my.gguf');
    const out = await resolveModel({ projectRoot: root, role: 'llm', spec: { path: 'weights/my.gguf' } });
    expect(out).toBe(path.join(root, 'weights/my.gguf'));
  });

  it('explicit path: missing → throws', async () => {
    await expect(
      resolveModel({ projectRoot: root, role: 'llm', spec: { path: 'nope.gguf' } }),
    ).rejects.toThrow(/not found/);
  });

  it('id with an existing slot → used without a fetch', async () => {
    put('models/llm/reasoning-4b.gguf');
    const out = await resolveModel({ projectRoot: root, role: 'llm', spec: { id: 'reasoning-4b' } });
    expect(out).toBe(path.join(root, 'models/llm/reasoning-4b.gguf'));
  });

  it('no spec + sole .gguf → adopted', async () => {
    put('models/llm/whatever.gguf');
    const out = await resolveModel({ projectRoot: root, role: 'llm' });
    expect(out).toBe(path.join(root, 'models/llm/whatever.gguf'));
  });

  it('no spec + >1 .gguf → fails clearly (never guesses)', async () => {
    put('models/llm/a.gguf');
    put('models/llm/b.gguf');
    await expect(resolveModel({ projectRoot: root, role: 'llm' })).rejects.toThrow(/Ambiguous/);
  });

  it('no spec + empty role dir → clear error', async () => {
    await expect(resolveModel({ projectRoot: root, role: 'llm' })).rejects.toThrow(/No model configured/);
  });

  it('id with path traversal → rejected (no escape from models/)', async () => {
    await expect(
      resolveModel({ projectRoot: root, role: 'llm', spec: { id: '../../etc/passwd' } }),
    ).rejects.toThrow(/Invalid model id/);
  });

  it('role with path traversal → rejected', async () => {
    await expect(
      resolveModel({ projectRoot: root, role: '../evil' as ModelRole }),
    ).rejects.toThrow(/Invalid model role/);
  });

  it('id containing ".." → rejected (matches the docstring)', async () => {
    await expect(
      resolveModel({ projectRoot: root, role: 'llm', spec: { id: 'a..b' } }),
    ).rejects.toThrow(/Invalid model id/);
  });

  it('role path is a file (not a directory) → clear error, no ENOTDIR crash', async () => {
    fs.mkdirSync(path.join(root, 'models'), { recursive: true });
    fs.writeFileSync(path.join(root, 'models', 'llm'), 'oops'); // models/llm is a FILE
    await expect(resolveModel({ projectRoot: root, role: 'llm' })).rejects.toThrow(/No model configured/);
  });

  it('a directory named *.gguf is not adopted (regular files only)', async () => {
    fs.mkdirSync(path.join(root, 'models', 'llm', 'notamodel.gguf'), { recursive: true });
    await expect(resolveModel({ projectRoot: root, role: 'llm' })).rejects.toThrow(/No model configured/);
  });
});

describe('fetchVerified — streaming digest verification', () => {
  const bytes = new TextEncoder().encode('GGUF-TEST-BYTES');
  const entry = (sha: string, urls: string[]): ModelCatalogEntry => ({
    id: 't',
    role: 'llm',
    label: 'Test Model',
    urls,
    sha256: sha,
    sizeBytes: bytes.length,
  });

  it('digest match → writes the slot, returns its path', async () => {
    const dest = path.join(root, 'models/llm/t.gguf');
    const out = await fetchVerified(entry(sha256(bytes), ['mock://ok']), dest, {
      fetchImpl: mockFetch({ 'mock://ok': bytes }),
    });
    expect(out).toBe(dest);
    expect(fs.readFileSync(dest)).toEqual(Buffer.from(bytes));
  });

  it('digest mismatch → throws + deletes .partial (nothing written)', async () => {
    const dest = path.join(root, 'models/llm/t.gguf');
    await expect(
      fetchVerified(entry('de'.repeat(32), ['mock://bad']), dest, {
        fetchImpl: mockFetch({ 'mock://bad': bytes }),
      }),
    ).rejects.toThrow(/Digest mismatch/);
    expect(fs.existsSync(dest)).toBe(false);
    const leftover = fs.readdirSync(path.dirname(dest)).filter((f) => f.includes('.partial'));
    expect(leftover).toHaveLength(0);
  });

  it('URL fallback → first fails, second succeeds', async () => {
    const dest = path.join(root, 'models/llm/t.gguf');
    const out = await fetchVerified(entry(sha256(bytes), ['mock://down', 'mock://up']), dest, {
      fetchImpl: mockFetch({ 'mock://down': new Error('ECONNREFUSED'), 'mock://up': bytes }),
    });
    expect(out).toBe(dest);
    expect(fs.readFileSync(dest)).toEqual(Buffer.from(bytes));
  });

  it('dest already present (concurrent winner) → resolves without error', async () => {
    const dest = path.join(root, 'models/llm/t.gguf');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(bytes)); // a prior/concurrent verified copy
    const out = await fetchVerified(entry(sha256(bytes), ['mock://ok']), dest, {
      fetchImpl: mockFetch({ 'mock://ok': bytes }),
    });
    expect(out).toBe(dest);
    expect(fs.readFileSync(dest)).toEqual(Buffer.from(bytes));
  });

  it('all URLs fail → aggregated error naming each source', async () => {
    const dest = path.join(root, 'models/llm/t.gguf');
    await expect(
      fetchVerified(entry(sha256(bytes), ['mock://a', 'mock://b']), dest, {
        fetchImpl: mockFetch({ 'mock://a': new Error('boom-a'), 'mock://b': new Error('boom-b') }),
      }),
    ).rejects.toThrow(/Failed to fetch[\s\S]*boom-a[\s\S]*boom-b/);
  });
});
