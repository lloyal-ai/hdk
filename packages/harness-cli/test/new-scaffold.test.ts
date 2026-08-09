import { describe, it, expect, afterEach, vi } from 'vitest';
import { cpSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneTargets, type Target } from '../src/scaffold/prune-targets.js';
import { applyModelChoice, isModelPath } from '../src/scaffold/apply-model.js';
import { modelsForRole, MODEL_CATALOG } from '../src/scaffold/model-catalog.js';
import { newCommand } from '../src/commands/new.js';

const BASIC_TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'basic');

const created: string[] = [];
function freshBlankProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-scaffold-'));
  cpSync(BASIC_TEMPLATE, dir, { recursive: true });
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

describe('desktop target — the three things electron-vite needs', () => {
  const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

  it.each(['basic', 'research'] as const)(
    '%s: package.json declares the Electron entry point',
    (template) => {
      // electron-vite refuses to launch without it: "No entry point found for
      // electron app, please add a 'main' field to package.json".
      const pkgJson = JSON.parse(readFileSync(join(TEMPLATES, template, 'package.json'), 'utf8'));
      expect(pkgJson.main).toBe('out/main/main.js');
    },
  );

  it.each(['basic', 'research'] as const)(
    '%s: the preload path matches what electron-vite emits',
    (template) => {
      // electron-vite names the bundle after its entry and emits ESM as .mjs, so
      // `out/preload/preload.mjs`. Pointing at `index.js` fails SILENTLY — no
      // bridge, blank window.
      const main = readFileSync(join(TEMPLATES, template, 'targets/desktop/main.ts'), 'utf8');
      const entry = readFileSync(join(TEMPLATES, template, 'electron.vite.config.ts'), 'utf8');
      expect(entry).toContain('targets/desktop/preload.ts');
      expect(main).toContain('"../preload/preload.mjs"');
      expect(main).not.toContain('"../preload/index.js"');
    },
  );

  it.each(['basic', 'research'] as const)(
    '%s: the desktop scripts guard the Electron binary first',
    (template) => {
      // electron 42 dropped `postinstall: node install.js`, so `npm install`
      // never fetches the binary and electron-vite dies with "Electron uninstall".
      const pkgJson = JSON.parse(readFileSync(join(TEMPLATES, template, 'package.json'), 'utf8'));
      expect(pkgJson.scripts['predev:desktop']).toContain('node bin/ensure-electron.js');
      expect(pkgJson.scripts['prebuild:desktop']).toContain('node bin/ensure-electron.js');
      expect(existsSync(join(TEMPLATES, template, 'bin/ensure-electron.js'))).toBe(true);
      // The pin must stay on a version whose binary this guard can fetch.
      expect(pkgJson.devDependencies.electron).toMatch(/\^4[2-9]\./);
    },
  );

  it('cli-only prunes `main`, the guard script, and both pre* hooks', () => {
    const dir = freshBlankProject();
    pruneTargets(dir, ['cli']);
    const p = pkg(dir) as { main?: string; scripts: Record<string, string> };
    expect(p.main).toBeUndefined(); // out/ is desktop-only — a dangling entry point
    expect(p.scripts['predev:desktop']).toBeUndefined();
    expect(p.scripts['prebuild:desktop']).toBeUndefined();
    expect(existsSync(join(dir, 'bin/ensure-electron.js'))).toBe(false);
  });

  it('keeping desktop keeps all three', () => {
    const dir = freshBlankProject();
    pruneTargets(dir, ['cli', 'desktop']);
    const p = pkg(dir) as { main?: string; scripts: Record<string, string> };
    expect(p.main).toBe('out/main/main.js');
    expect(p.scripts['prebuild:desktop']).toContain('node bin/ensure-electron.js');
    expect(existsSync(join(dir, 'bin/ensure-electron.js'))).toBe(true);
  });
});

describe('preflight-apps — the app guard runs before the compiler', () => {
  const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

  it.each(['basic', 'research'] as const)(
    '%s: prestart and both desktop pre-hooks run the guard first',
    (template) => {
      // `harness/harness.ts` imports its apps at the top level, so a scaffold
      // missing them fails inside tsc with TS2307 — the compiler complaining
      // about a supply problem. The guard has to run AHEAD of the build step.
      const pkgJson = JSON.parse(readFileSync(join(TEMPLATES, template, 'package.json'), 'utf8'));
      for (const s of ['prestart', 'predev:desktop', 'prebuild:desktop']) {
        expect(pkgJson.scripts[s].startsWith('node bin/preflight-apps.js &&')).toBe(true);
      }
      expect(existsSync(join(TEMPLATES, template, 'bin/preflight-apps.js'))).toBe(true);
    },
  );

  it('is cli-owned: a cli-only prune keeps the guard and prestart', () => {
    // Unlike ensure-electron.js it must NOT be in TARGET_FILES — `prestart`
    // belongs to the cli target, which is never pruned.
    const dir = freshBlankProject();
    pruneTargets(dir, ['cli']);
    const p = pkg(dir) as { scripts: Record<string, string> };
    expect(existsSync(join(dir, 'bin/preflight-apps.js'))).toBe(true);
    expect(p.scripts.prestart).toContain('node bin/preflight-apps.js');
  });
});

describe('the shared React view outlives either DOM target alone', () => {
  const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
  const SHARED = 'targets/_shared/App.tsx';

  /** Entries of a JSONC array field, comments stripped. */
  function jsoncArray(file: string, key: string): string[] {
    const raw = readFileSync(file, 'utf8').replace(/\/\/.*/g, '');
    return (JSON.parse(raw) as Record<string, string[]>)[key] ?? [];
  }

  it.each([
    ['cli,web (desktop pruned)', ['cli', 'web']],
    ['cli,desktop (web pruned)', ['cli', 'desktop']],
  ] as const)('%s keeps it — the surviving target still mounts it', (_label, keep) => {
    const dir = freshBlankProject();
    pruneTargets(dir, keep as unknown as Target[]);
    expect(existsSync(join(dir, SHARED))).toBe(true);
    // …and typecheck still covers it.
    expect(jsoncArray(join(dir, 'tsconfig.web.json'), 'include')).toContain(SHARED);
  });

  it('cli-only drops it, and takes its dangling Node exclude entry with it', () => {
    const dir = freshBlankProject();
    pruneTargets(dir, ['cli']);
    expect(existsSync(join(dir, 'targets/_shared'))).toBe(false);
    expect(jsoncArray(join(dir, 'tsconfig.json'), 'exclude')).not.toContain('targets/_shared');
  });

  /**
   * Every module specifier in a file, across all three import forms — `from "x"`,
   * side-effect `import "x"`, and dynamic `import("x")` (which also covers
   * `export … from`). Matching the SPECIFIER rather than the import syntax is
   * what makes this depth- and form-agnostic; the earlier version only saw
   * `from "../x/"` and would have missed a side-effect CSS import outright.
   */
  function specifiers(file: string): string[] {
    const src = readFileSync(file, 'utf8');
    return [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1]);
  }

  function walkSources(dir: string, fn: (file: string) => void): void {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walkSources(p, fn);
      else if (/\.(ts|tsx)$/.test(e.name)) fn(p);
    }
  }

  it.each(['basic', 'research'] as const)(
    '%s: no target imports across into another target',
    (template) => {
      // THE INVARIANT. web/main.tsx used to import ../desktop/App.js, so pruning
      // desktop stranded it — broken since 0.6.4 and caught by nothing, because
      // the all-three default scaffold resolves fine. Any future shared file
      // parked inside one target trips this.
      const root = join(TEMPLATES, template, 'targets');
      const offenders: string[] = [];
      for (const owner of ['cli', 'desktop', 'web']) {
        walkSources(join(root, owner), (file) => {
          for (const spec of specifiers(file)) {
            if (!spec.startsWith('.')) continue;
            // Resolve rather than pattern-match, so `../../desktop/x` and
            // `../desktop/x` are judged the same way.
            const rel = relative(root, resolve(dirname(file), spec));
            const [dir] = rel.split(sep);
            if (rel.startsWith('..') || dir === owner || dir === '_shared') continue;
            offenders.push(`${owner}/${basename(file)} → ${dir}`);
          }
        });
      }
      expect(offenders).toEqual([]);
    },
  );

  it.each(['basic', 'research'] as const)(
    '%s: the harness runtime path has no dynamic import()',
    (template) => {
      // Metro needs a statically analysable module graph, so a dynamic import
      // under harness/ or targets/ forecloses a future React Native target.
      // `bin/` is exempt on purpose — those are boot shims, not runtime.
      const offenders: string[] = [];
      for (const sub of ['harness', 'targets']) {
        walkSources(join(TEMPLATES, template, sub), (file) => {
          if (/\bimport\s*\(/.test(readFileSync(file, 'utf8'))) {
            offenders.push(relative(join(TEMPLATES, template), file));
          }
        });
      }
      expect(offenders).toEqual([]);
    },
  );
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
  it('scaffolds a cli-only basic with a BYO --model path written as `path:`', async () => {
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
      '--skip-apps',
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
    const code = await newCommand.run([
      'dflt',
      '--dir',
      parent,
      '--targets',
      'cli',
      '--model',
      '   ',
      '--skip-apps',
    ]);
    out.mockRestore();

    expect(code).toBe(0);
    const yml = readFileSync(join(parent, 'dflt', 'harness.yml'), 'utf8');
    expect(yml).toMatch(/id:\s*"qwen3.5-4b"/); // the catalog default, not an empty value
    expect(yml).not.toMatch(/(id|path):\s*""/);
  });

  it('emits a real .gitignore (the template stores it undotted so npm ships it)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'harness-new-'));
    created.push(parent);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await newCommand.run(['ign', '--dir', parent, '--targets', 'cli', '--skip-apps']);
    out.mockRestore();

    expect(code).toBe(0);
    const dir = join(parent, 'ign');
    expect(existsSync(join(dir, '.gitignore'))).toBe(true);
    expect(existsSync(join(dir, 'gitignore'))).toBe(false); // the undotted name must not leak
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toMatch(/^node_modules\/$/m);
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
