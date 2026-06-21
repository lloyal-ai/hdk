/**
 * Tests for the publish-time attention-surface extraction. The "real app" cases
 * construct the actual built first-party apps in an isolated subprocess and read
 * their tool schemas (the genuinely novel mechanism); the fallback case proves a
 * non-constructable app degrades LOUDLY to tool NAMES rather than throwing.
 */
import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildAttentionSurface, type DescribeAppJson, type DescribePackageJson } from '../src/describe';

const APPS_DIR = fileURLToPath(new URL('../../apps', import.meta.url));

async function readApp(name: string): Promise<{ dir: string; app: DescribeAppJson; pkg: DescribePackageJson }> {
  const dir = join(APPS_DIR, name);
  const app = JSON.parse(await readFile(join(dir, 'app.json'), 'utf-8')) as DescribeAppJson;
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8')) as DescribePackageJson;
  return { dir, app, pkg };
}

describe('buildAttentionSurface — real first-party apps', () => {
  it('wikipedia: full tool schemas + skill + useWhen, not degraded', async () => {
    const { dir, app, pkg } = await readApp('wikipedia');
    const s = await buildAttentionSurface(dir, app, pkg);
    expect(s.degraded).toBeUndefined();
    expect(s.protocol.name).toBe('wikipedia_research');
    expect(s.protocol.useWhen.length).toBeGreaterThan(0);
    expect(s.skill.length).toBeGreaterThan(0);
    const names = s.tools.map((t) => t.name).sort();
    expect(names).toEqual(['wikipedia_fetch', 'wikipedia_search']);
    for (const t of s.tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.parameters).not.toBeNull();
    }
  }, 60_000);

  it('corpus: constructs over a seeded temp dir → full schemas', async () => {
    const { dir, app, pkg } = await readApp('corpus');
    const s = await buildAttentionSurface(dir, app, pkg);
    expect(s.tools.map((t) => t.name).sort()).toEqual(['grep', 'read_file', 'search']);
    expect(s.tools.every((t) => t.description.length > 0)).toBe(true);
    expect(s.degraded).toBeUndefined();
  }, 60_000);
});

describe('buildAttentionSurface — fallback', () => {
  it('degrades LOUDLY to app.json tool NAMES when the app cannot be constructed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'describe-fallback-'));
    await mkdir(join(dir, 'dist'), { recursive: true });
    // A dist that throws on require + no node_modules → subprocess fails → fallback.
    await writeFile(join(dir, 'dist', 'index.js'), 'throw new Error("boom");');
    await writeFile(join(dir, 'skill.eta'), 'the skill template');
    const app: DescribeAppJson = {
      name: 'broken',
      protocol: { name: 'broken_protocol', useWhen: 'never', tools: ['alpha', 'beta'] },
    };
    const pkg: DescribePackageJson = { name: '@x/broken', version: '1.0.0', main: 'dist/index.js' };

    const s = await buildAttentionSurface(dir, app, pkg);
    expect(s.degraded).toBe(true);
    expect(s.tools.map((t) => t.name)).toEqual(['alpha', 'beta']);
    expect(s.tools.every((t) => t.description === '' && t.parameters === null)).toBe(true);
    expect(s.skill).toBe('the skill template'); // skill.eta still read
    expect(s.protocol.useWhen).toBe('never');
  }, 60_000);
});
