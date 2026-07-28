import { describe, it, expect, afterEach, vi } from 'vitest';
import { cpSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneTargets } from '../src/scaffold/prune-targets.js';
import { applyModelChoice, isModelPath } from '../src/scaffold/apply-model.js';
import { modelsForRole, MODEL_CATALOG } from '../src/scaffold/model-catalog.js';
import { newCommand } from '../src/commands/new.js';

const BLANK_TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'blank');

const created: string[] = [];
function freshBlankProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-scaffold-'));
  cpSync(BLANK_TEMPLATE, dir, { recursive: true });
  created.push(dir);
  return dir;
}
function pkg(dir: string): {
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

afterEach(() => {
  while (created.length) rmSync(created.pop() as string, { recursive: true, force: true });
});

describe('pruneTargets — cli-only', () => {
  it('removes desktop + web dirs, bin shim, and both extra tsconfigs', () => {
    const dir = freshBlankProject();
    pruneTargets(dir, ['cli']);
    expect(existsSync(join(dir, 'targets/cli'))).toBe(true);
    expect(existsSync(join(dir, 'targets/desktop'))).toBe(false);
    expect(existsSync(join(dir, 'targets/web'))).toBe(false);
    expect(existsSync(join(dir, 'bin/serve.js'))).toBe(false);
    expect(existsSync(join(dir, 'electron.vite.config.ts'))).toBe(false);
    expect(existsSync(join(dir, 'tsconfig.electron.json'))).toBe(false);
    expect(existsSync(join(dir, 'tsconfig.web.json'))).toBe(false);
  });

  it('drops every per-target dep incl. the shared renderer deps', () => {
    const dir = freshBlankProject();
    pruneTargets(dir, ['cli']);
    const p = pkg(dir);
    for (const dep of ['@lloyal-labs/host', 'ws', 'react-dom']) {
      expect(p.dependencies?.[dep]).toBeUndefined();
    }
    for (const dep of ['electron', 'electron-vite', 'vite', '@vitejs/plugin-react', '@types/ws', '@types/react-dom']) {
      expect(p.devDependencies?.[dep]).toBeUndefined();
    }
    // cli core deps survive
    expect(p.dependencies?.ink).toBeDefined();
    expect(p.dependencies?.react).toBeDefined();
  });

  it('collapses scripts + typecheck to the cli set', () => {
    const dir = freshBlankProject();
    pruneTargets(dir, ['cli']);
    const p = pkg(dir);
    for (const s of ['dev:desktop', 'build:desktop', 'serve', 'dev:web', 'build:web']) {
      expect(p.scripts[s]).toBeUndefined();
    }
    expect(p.scripts.start).toBeDefined();
    expect(p.scripts.typecheck).toBe('tsc --noEmit');
    expect(readFileSync(join(dir, 'harness.yml'), 'utf8')).toMatch(/^targets: \[cli\]$/m);
  });
});

describe('pruneTargets — cli + web (desktop pruned)', () => {
  it('keeps web deps/scripts, drops only desktop, trims tsconfig.web include', () => {
    const dir = freshBlankProject();
    pruneTargets(dir, ['cli', 'web']);
    expect(existsSync(join(dir, 'targets/web'))).toBe(true);
    expect(existsSync(join(dir, 'targets/desktop'))).toBe(false);
    expect(existsSync(join(dir, 'electron.vite.config.ts'))).toBe(false);
    expect(existsSync(join(dir, 'tsconfig.electron.json'))).toBe(false);
    expect(existsSync(join(dir, 'tsconfig.web.json'))).toBe(true);

    const p = pkg(dir);
    expect(p.devDependencies?.electron).toBeUndefined();
    expect(p.devDependencies?.['electron-vite']).toBeUndefined();
    expect(p.dependencies?.['@lloyal-labs/host']).toBeDefined();
    expect(p.devDependencies?.vite).toBeDefined(); // shared renderer dep kept — web survives
    expect(p.dependencies?.['react-dom']).toBeDefined();
    expect(p.scripts.serve).toBeDefined();
    expect(p.scripts['dev:desktop']).toBeUndefined();
    expect(p.scripts.typecheck).toBe('tsc --noEmit && tsc -p tsconfig.web.json');

    const webCfg = readFileSync(join(dir, 'tsconfig.web.json'), 'utf8');
    expect(webCfg).not.toContain('targets/desktop');
    expect(webCfg).toContain('targets/web/main.tsx');
    expect(readFileSync(join(dir, 'harness.yml'), 'utf8')).toMatch(/^targets: \[cli, web\]$/m);
  });
});

describe('pruneTargets — guards', () => {
  it('throws when cli is not kept', () => {
    const dir = freshBlankProject();
    expect(() => pruneTargets(dir, ['desktop', 'web'])).toThrow(/cli.*mandatory/i);
  });

  it('all three kept is a no-op for the target dirs', () => {
    const dir = freshBlankProject();
    pruneTargets(dir, ['cli', 'desktop', 'web']);
    expect(existsSync(join(dir, 'targets/desktop'))).toBe(true);
    expect(existsSync(join(dir, 'targets/web'))).toBe(true);
  });
});

describe('isModelPath', () => {
  it('classifies catalog ids as ids and .gguf/paths as paths', () => {
    // Bare slugs stay ids — even unknown ones, so the picker survives catalog drift.
    expect(isModelPath('qwen3.5-4b')).toBe(false);
    expect(isModelPath('custom-model')).toBe(false);
    // Anything path-shaped is BYO.
    expect(isModelPath('./models/llm/x.gguf')).toBe(true);
    expect(isModelPath('/abs/path/model.gguf')).toBe(true);
    expect(isModelPath('models/llm/x.gguf')).toBe(true);
    expect(isModelPath('bare.gguf')).toBe(true);
    expect(isModelPath('~/models/x.gguf')).toBe(true);
  });
});

describe('applyModelChoice', () => {
  it('rewrites model.llm id + context, preserving comments', () => {
    const dir = freshBlankProject();
    applyModelChoice(dir, { llm: 'custom-model', context: 8192 });
    const yml = readFileSync(join(dir, 'harness.yml'), 'utf8');
    expect(yml).toMatch(/id:\s*"custom-model"/);
    expect(yml).toMatch(/context:\s*8192/);
    expect(yml).toContain('kvCache'); // the inline guidance comment survives
  });

  it('writes a BYO path as `path:` (not `id:`), keeping the comment', () => {
    const dir = freshBlankProject();
    applyModelChoice(dir, { llm: './models/llm/custom.gguf' });
    const yml = readFileSync(join(dir, 'harness.yml'), 'utf8');
    expect(yml).toMatch(/path:\s*"\.\/models\/llm\/custom\.gguf"/);
    // The llm block must NOT still carry an `id:` line — a model entry is id XOR path.
    const llmBlock = yml.slice(yml.indexOf('llm:'), yml.indexOf('context:'));
    expect(llmBlock).not.toMatch(/\bid:/);
    expect(yml).toContain('kvCache'); // guidance comment survives the key swap
    expect(yml).toMatch(/context:\s*32768/); // context left at the template default
  });

  it('escapes a BYO path with backslashes + quotes into valid double-quoted YAML', () => {
    const dir = freshBlankProject();
    // A Windows path with an embedded quote — must not produce invalid YAML.
    applyModelChoice(dir, { llm: 'C:\\models\\my "best".gguf' });
    const yml = readFileSync(join(dir, 'harness.yml'), 'utf8');
    // JSON.stringify escaping: backslashes doubled, inner quotes backslash-escaped.
    expect(yml).toContain('path: "C:\\\\models\\\\my \\"best\\".gguf"');
  });

  it('leaves context untouched when not given', () => {
    const dir = freshBlankProject();
    applyModelChoice(dir, { llm: 'qwen3.5-4b' });
    expect(readFileSync(join(dir, 'harness.yml'), 'utf8')).toMatch(/context:\s*32768/);
  });

  it('throws when there is no model: block at all', () => {
    const dir = freshBlankProject();
    writeFileSync(join(dir, 'harness.yml'), 'targets: [cli]\n');
    expect(() => applyModelChoice(dir, { llm: 'x' })).toThrow(/model:/);
  });
});

describe('newCommand.run — non-interactive flag path (end-to-end)', () => {
  it('scaffolds a cli-only blank with a BYO --model path written as `path:`', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'harness-new-'));
    created.push(parent);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await newCommand.run([
      'byoproj',
      '--dir',
      parent,
      '--targets',
      'cli',
      '--model',
      './models/llm/mine.gguf',
    ]);
    out.mockRestore();

    expect(code).toBe(0);
    const yml = readFileSync(join(parent, 'byoproj', 'harness.yml'), 'utf8');
    expect(yml).toMatch(/path:\s*"\.\/models\/llm\/mine\.gguf"/);
    // cli-only prune landed too — desktop/web are gone.
    expect(existsSync(join(parent, 'byoproj', 'targets/desktop'))).toBe(false);
    expect(existsSync(join(parent, 'byoproj', 'targets/web'))).toBe(false);
    expect(existsSync(join(parent, 'byoproj', 'targets/cli'))).toBe(true);
  });

  it('treats an empty/whitespace --model as not provided (uses the catalog default)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'harness-new-'));
    created.push(parent);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await newCommand.run(['dflt', '--dir', parent, '--targets', 'cli', '--model', '   ']);
    out.mockRestore();

    expect(code).toBe(0);
    const yml = readFileSync(join(parent, 'dflt', 'harness.yml'), 'utf8');
    expect(yml).toMatch(/id:\s*"qwen3.5-4b"/); // the catalog default, not an empty value
    expect(yml).not.toMatch(/(id|path):\s*""/);
  });

  it('refuses to scaffold over an existing FILE (not just a directory)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'harness-new-'));
    created.push(parent);
    writeFileSync(join(parent, 'taken'), 'i am a file, not a directory');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await newCommand.run(['taken', '--dir', parent, '--yes']);
    err.mockRestore();
    out.mockRestore();
    // Errors cleanly (exit 1) rather than crashing later on mkdirSync EEXIST.
    expect(code).toBe(1);
  });
});

describe('model-catalog (vendored)', () => {
  it('offers the default llm', () => {
    const llms = modelsForRole('llm');
    expect(llms.length).toBeGreaterThan(0);
    expect(llms[0].id).toBe('qwen3.5-4b');
    expect(llms[0].recommendedContext).toBe(32768);
  });

  it('carries a reranker entry too', () => {
    expect(MODEL_CATALOG.some((m) => m.role === 'reranker')).toBe(true);
  });
});
