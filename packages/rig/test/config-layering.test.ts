/**
 * One declaration per key; rig layers `cli > env > harness.json > harness.yml >
 * default`, computes provenance as it goes, validates and resolves paths, over the
 * disk mechanics in config-node. The committed rung fails loud, the local rung
 * falls through, an empty string clears, and the abilities family is layered for
 * every app. Ported from casework's config tests, then the laws the two templates'
 * hand-written loaders shared.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isGuardOverrides } from '@lloyal-labs/lloyal-agents';
import { defineConfig, modelSettings } from '../src/config';
import { loadYml, loadConfig, saveLocalConfig, runnerConfig } from '../src/config-layering';
import { makeEdgeRunner, makeServedRunner } from '../src/runner';

let cwd: string;
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-config-')); });
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

const writeJson = (v: unknown) => fs.writeFileSync(path.join(cwd, 'harness.json'), JSON.stringify(v));
const readJson = () => JSON.parse(fs.readFileSync(path.join(cwd, 'harness.json'), 'utf8'));
const writeYml = (text: string) => fs.writeFileSync(path.join(cwd, 'harness.yml'), text);

const GUARDS = { url_dedup: { scope: 'cohort' as const }, query_dedup: { scope: 'cohort' as const } };

/** An app's table: the model block, then its own keys. */
const app = defineConfig({
  ...modelSettings,
  'sources.outputDir': { yml: 'sources.outputDir', cli: 'outputDir', path: true, default: 'reports' },
  'defaults.effort': { yml: 'defaults.effort', oneOf: ['low', 'medium', 'high', 'ultra'], default: 'high' },
  'defaults.reasoningMode': { yml: 'defaults.reasoningMode', cli: 'reasoningMode', oneOf: ['flat', 'deep'], default: 'flat' },
  'defaults.guards': { yml: 'defaults.guards', check: isGuardOverrides },
});

describe('the model block (casework config.test.ts, ported)', () => {
  it('model.llm.mmproj reaches config.model.mmproj', () => {
    const { config } = loadConfig(modelSettings, { model: { llm: { id: 'qwen3.5-4b-q4', mmproj: 'mmproj-qwen3.5-4b-f16' } } }, { env: {}, cwd });
    expect(config.model.mmproj).toBe('mmproj-qwen3.5-4b-f16');
    expect(config.model.id).toBe('qwen3.5-4b-q4');
  });

  it("the local overlay's model.mmproj wins over harness.yml", () => {
    writeJson({ version: 1, sources: {}, abilities: {}, defaults: {}, model: { mmproj: 'local-projector' } });
    const { config, origin } = loadConfig(modelSettings, { model: { llm: { id: 'qwen3.5-4b-q4', mmproj: 'yml-projector' } } }, { env: {}, cwd });
    expect(config.model.mmproj).toBe('local-projector');
    expect(origin['model.mmproj']).toBe('file');
  });
});

describe("the app's keys (casework config.test.ts, ported)", () => {
  it('a committed defaults.guards loads, and survives a local effort save', () => {
    const yml = { defaults: { guards: GUARDS } };
    expect(loadConfig(app, yml, { env: {}, cwd }).config.defaults.guards).toEqual(GUARDS);
    saveLocalConfig({ defaults: { effort: 'medium' } }, cwd);
    const { config } = loadConfig(app, yml, { env: {}, cwd });
    expect(config.defaults.effort).toBe('medium');
    expect(config.defaults.guards).toEqual(GUARDS);
  });

  it("absent defaults.guards stays absent: the framework's default applies", () => {
    expect(loadConfig(app, {}, { env: {}, cwd }).config.defaults.guards).toBeUndefined();
  });

  it('the committed rung fails loud on a malformed defaults.guards; the local rung falls through', () => {
    writeYml('defaults:\n  guards:\n    url_dedup: sometimes\n');
    expect(() => loadYml(app, cwd)).toThrow(/defaults\.guards/);
    writeJson({ version: 1, sources: {}, abilities: {}, defaults: { guards: { url_dedup: 'sometimes' } } });
    expect(loadConfig(app, { defaults: { guards: GUARDS } }, { env: {}, cwd }).config.defaults.guards).toEqual(GUARDS);
  });
});

describe('the rungs, and the provenance that falls out of them', () => {
  it('cli > env > harness.json > harness.yml > default, each reported as the rung it came from', () => {
    writeJson({ version: 1, sources: { outputDir: '/local' }, abilities: {}, model: { nCtx: 2048 } });
    const yml = { sources: { outputDir: '/yml' }, model: { llm: { context: 1024 } } };
    const a = loadConfig(app, yml, { cli: { outputDir: '/cli' }, env: { LLAMA_CTX_SIZE: '4096' }, cwd });
    expect(a.config.sources.outputDir).toBe('/cli');
    expect(a.origin['sources.outputDir']).toBe('cli');
    expect(a.config.model.nCtx).toBe(4096);
    expect(a.origin['model.nCtx']).toBe('env');
    const b = loadConfig(app, yml, { env: {}, cwd });
    expect(b.config.sources.outputDir).toBe('/local');
    expect(b.origin['sources.outputDir']).toBe('file');
    expect(b.config.model.nCtx).toBe(2048);
    fs.rmSync(path.join(cwd, 'harness.json'));
    const c = loadConfig(app, yml, { env: {}, cwd });
    expect(c.config.sources.outputDir).toBe('/yml');
    expect(c.origin['sources.outputDir']).toBe('yml');
    expect(c.config.model.nCtx).toBe(1024);
    expect(c.origin['model.nCtx']).toBe('yml');
    const d = loadConfig(app, {}, { env: {}, cwd });
    expect(d.config.sources.outputDir).toBe(path.resolve('reports'));
    expect(d.origin['sources.outputDir']).toBe('default');
    expect(d.config.defaults.effort).toBe('high');
    expect(d.origin['defaults.effort']).toBe('default');
    expect(d.config.model.nCtx).toBeUndefined();
    expect(d.origin['model.nCtx']).toBe('default');
    expect(d.loadedFromFile).toBe(false);
    expect(d.path).toBe(path.join(cwd, 'harness.json'));
  });

  it('an env value the key cannot take falls through, and so does a hand-edited local one', () => {
    writeJson({ version: 1, sources: {}, abilities: {}, model: { nCtx: 'lots', gpu: 'tpu' }, defaults: { effort: 'max' } });
    const { config, origin } = loadConfig(app, { model: { llm: { context: 1024, gpu: 'cuda' } }, defaults: { effort: 'low' } }, { env: { LLAMA_CTX_SIZE: '12k', LLOYAL_GPU: 'quantum' }, cwd });
    expect(config.model.nCtx).toBe(1024);
    expect(origin['model.nCtx']).toBe('yml');
    expect(config.model.gpu).toBe('cuda');
    expect(config.defaults.effort).toBe('low');
  });

  it('an empty string is a clear at every rung: the value comes from the rung beneath', () => {
    writeJson({ version: 1, sources: { outputDir: '' }, abilities: {}, model: { path: '' } });
    const { config, origin } = loadConfig(app, { sources: { outputDir: '/yml' }, model: { llm: { path: '/yml/model.gguf' } } }, { cli: { outputDir: '' }, env: {}, cwd });
    expect(config.sources.outputDir).toBe('/yml');
    expect(origin['sources.outputDir']).toBe('yml');
    expect(config.model.path).toBe('/yml/model.gguf');
  });

  it('a path key is expanded and made absolute at the boundary', () => {
    const { config } = loadConfig(app, { sources: { outputDir: '~/briefs' }, model: { llm: { path: './m.gguf' } } }, { env: {}, cwd });
    expect(config.sources.outputDir).toBe(path.join(os.homedir(), 'briefs'));
    expect(config.model.path).toBe(path.resolve('./m.gguf'));
  });

  it('the committed rung fails loud, naming the yml path and what it takes', () => {
    writeYml('model:\n  llm:\n    gpu: tpu\n');
    expect(() => loadYml(app, cwd)).toThrow('harness.yml: model.llm.gpu must be default, cuda, or vulkan (got "tpu")');
    writeYml('model:\n  llm:\n    context: lots\n');
    expect(() => loadYml(app, cwd)).toThrow('harness.yml: model.llm.context must be a positive integer (got "lots")');
    writeYml('defaults:\n  effort: max\n');
    expect(() => loadYml(app, cwd)).toThrow('harness.yml: defaults.effort must be low, medium, high, or ultra (got "max")');
    writeYml('model:\n  llm:\n    id: qwen3.5-4b\n    context: 32768\ndefaults:\n  effort: low\n  guards:\n    url_dedup: { scope: cohort }\n');
    const yml = loadYml(app, cwd);
    expect(yml.model?.llm?.context).toBe(32768);
    expect(loadConfig(app, yml, { env: {}, cwd }).config.defaults.guards).toEqual({ url_dedup: { scope: 'cohort' } });
    expect(() => loadYml(app, path.join(cwd, 'elsewhere'))).toThrow(/harness\.yml not found/);
  });
});

describe('the abilities family, layered for every app', () => {
  it('committed entries, then the local overlay whole-replacing a named ability, paths resolved', () => {
    writeJson({ version: 1, sources: {}, abilities: { web: { tavilyKey: 'k' } } });
    const { config } = loadConfig(modelSettings, { abilities: { corpus: { corpusPath: './docs' }, web: { tavilyKey: 'committed', region: 'eu' } } }, { env: {}, cwd });
    expect(config.abilities).toEqual({ corpus: { corpusPath: path.resolve('./docs') }, web: { tavilyKey: 'k' } });
  });
});

describe('saveLocalConfig', () => {
  it('merges each family over the file, clears on "", whole-replaces a named ability, keeps the rest', () => {
    writeJson({ version: 1, sources: { outputDir: '/old' }, abilities: { corpus: { corpusPath: '/c' }, web: { tavilyKey: 'k', region: 'eu' } }, model: { path: '/m', nCtx: 1024 }, defaults: { effort: 'low', guards: GUARDS } });
    const result = saveLocalConfig({ sources: { outputDir: '' }, abilities: { web: { tavilyKey: 'k2' } }, model: { path: '', gpu: 'cuda' }, defaults: { effort: 'medium' } }, cwd);
    expect(result.path).toBe(path.join(cwd, 'harness.json'));
    expect(readJson()).toEqual({
      version: 1,
      sources: {},
      abilities: { corpus: { corpusPath: '/c' }, web: { tavilyKey: 'k2' } },
      model: { nCtx: 1024, gpu: 'cuda' },
      defaults: { effort: 'medium', guards: GUARDS },
    });
  });

  it('a fresh file is written from the patch alone; a file it cannot understand is never rebuilt', () => {
    saveLocalConfig({ defaults: { effort: 'medium' } }, cwd);
    expect(readJson()).toEqual({ version: 1, sources: {}, abilities: {}, defaults: { effort: 'medium' } });
    writeJson({ version: 2, defaults: { effort: 'ultra' } });
    expect(() => saveLocalConfig({ defaults: { effort: 'low' } }, cwd)).toThrow(/version 2/);
    expect(readJson()).toEqual({ version: 2, defaults: { effort: 'ultra' } });
  });
});

describe('runnerConfig: what a boot hands the Runner', () => {
  it('a save persists, re-layers value and provenance together, and leaves the model block boot-frozen', () => {
    const yml = { model: { llm: { id: 'qwen3.5-4b', context: 32768 } }, defaults: { guards: GUARDS } };
    const cfg = runnerConfig(app, yml, { env: {}, cwd });
    const runner = makeEdgeRunner(cfg.config, cfg);
    expect(runner.config().defaults.effort).toBe('high');
    expect(runner.origin()['defaults.effort']).toBe('default');
    const saved = runner.saveConfig({ defaults: { effort: 'medium' } });
    expect(saved.path).toBe(path.join(cwd, 'harness.json'));
    expect(runner.config().defaults.effort).toBe('medium');
    expect(runner.origin()['defaults.effort']).toBe('file');
    expect(runner.config().defaults.guards).toEqual(GUARDS);
    runner.saveConfig({ model: { nCtx: 4096 } });
    expect(runner.config().model.nCtx).toBe(32768);
    expect(runner.origin()['model.nCtx']).toBe('yml');
    expect(readJson().model.nCtx).toBe(4096);
  });

  it('a served session patches in memory and every touched key reads `session`, by the key itself', () => {
    const cfg = runnerConfig(app, { sources: { outputDir: '/yml' } }, { env: {}, cwd });
    const runner = makeServedRunner(cfg.config, cfg);
    const saved = runner.saveConfig({ sources: { outputDir: '/mine' }, defaults: { reasoningMode: 'deep' } });
    expect(saved.path).toBeNull();
    expect(runner.config().sources.outputDir).toBe('/mine');
    expect(runner.origin()['sources.outputDir']).toBe('session');
    expect(runner.origin()['defaults.reasoningMode']).toBe('session');
    expect(runner.origin()['defaults.effort']).toBe('default');
    expect(fs.existsSync(path.join(cwd, 'harness.json'))).toBe(false);
  });
});

describe('defineConfig', () => {
  it('refuses the keys rig owns and a key that is both a leaf and a family', () => {
    expect(() => defineConfig({ version: { default: 2 } } as never)).toThrow(/version/);
    expect(() => defineConfig({ 'abilities.web': { yml: 'abilities.web' } })).toThrow(/abilities/);
    expect(() => defineConfig({ abilities: { yml: 'abilities' } })).toThrow(/abilities/);
    expect(() => defineConfig({ model: { default: {} }, 'model.nCtx': { integer: true } })).toThrow(/model/);
  });
});
