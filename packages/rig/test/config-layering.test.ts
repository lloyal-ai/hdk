/**
 * One declaration per key; rig layers `cli > env > harness.json > harness.yml >
 * default`, computes provenance as it goes, validates and resolves paths, over the
 * disk mechanics in config-node. The committed rung fails loud, the local rung
 * falls through, an empty string clears, and the abilities family is layered for
 * every app. A model block's presence is carried through the layering: `vision: {}`
 * is a request, and a default never makes one. Ported from casework's config
 * tests, then the laws the two templates' hand-written loaders shared.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isGuardOverrides } from '@lloyal-labs/lloyal-agents';
import { defineConfig, modelSettings, CONFIG_VERSION } from '../src/config';
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

describe('the model block: one block per model, its keys at their yml path', () => {
  it('model.vision.id reaches config.model.vision.id, beside the llm block', () => {
    const { config } = loadConfig(modelSettings, { model: { llm: { id: 'qwen3.5-4b-q4' }, vision: { id: 'mmproj-qwen3.5-4b-f16' } } }, { env: {}, cwd });
    expect(config.model.vision?.id).toBe('mmproj-qwen3.5-4b-f16');
    expect(config.model.llm?.id).toBe('qwen3.5-4b-q4');
  });

  it("the local overlay's model.vision.id wins over harness.yml", () => {
    writeJson({ version: CONFIG_VERSION, sources: {}, abilities: {}, model: { vision: { id: 'local-projector' } } });
    const { config, origin } = loadConfig(modelSettings, { model: { llm: { id: 'qwen3.5-4b-q4' }, vision: { id: 'yml-projector' } } }, { env: {}, cwd });
    expect(config.model.vision?.id).toBe('local-projector');
    expect(origin['model.vision.id']).toBe('file');
  });

  it('the reranker block carries its own tuning beside its selection, its context defaulted once the block is present', () => {
    const { config } = loadConfig(modelSettings, { model: { reranker: { id: 'qwen3-reranker-0.6b-q8', context: 8192 } } }, { env: {}, cwd });
    expect(config.model.reranker).toEqual({ id: 'qwen3-reranker-0.6b-q8', context: 8192 });
    expect(config.model.llm).toBeUndefined();
    expect(loadConfig(modelSettings, { model: { reranker: { id: 'r' } } }, { env: {}, cwd }).config.model.reranker).toEqual({ id: 'r', context: 16384 });
    expect('reranker' in loadConfig(modelSettings, {}, { env: {}, cwd }).config.model).toBe(false);
  });
});

describe('a block is present when a rung says so — its presence is the request, its keys the selection', () => {
  it('`vision: {}` in harness.yml survives the layering as an empty block; an absent block stays absent, its defaults with it', () => {
    const { config } = loadConfig(modelSettings, { model: { llm: { id: 'qwen3.5-4b' }, vision: {} } }, { env: {}, cwd });
    expect(config.model.vision).toEqual({});
    expect('reranker' in config.model).toBe(false);   // `model.reranker.context` has a default, and it did not make the block
  });

  it('a bare `vision:` line reads the same as `vision: {}`', () => {
    writeYml('model:\n  llm:\n    id: qwen3.5-4b\n  vision:\n');
    const { config } = loadConfig(modelSettings, loadYml(modelSettings, cwd), { env: {}, cwd });
    expect(config.model.vision).toEqual({});
  });

  it('the local overlay can request a block harness.yml never named, and a key of it', () => {
    writeJson({ version: CONFIG_VERSION, sources: {}, abilities: {}, model: { reranker: {} } });
    expect(loadConfig(modelSettings, {}, { env: {}, cwd }).config.model.reranker).toEqual({ context: 16384 });   // present, so its default stands
    writeJson({ version: CONFIG_VERSION, sources: {}, abilities: {}, model: { reranker: { context: 8192 } } });
    expect(loadConfig(modelSettings, {}, { env: {}, cwd }).config.model.reranker).toEqual({ context: 8192 });
  });

  it('a `default:` on a key inside a block never makes the block: nothing asked for the service', () => {
    // The real table, with one more default on the block than it ships with: the rule must hold for any default.
    const tuned = defineConfig({ ...modelSettings, 'model.embedding.pooling': { ...modelSettings['model.embedding.pooling'], default: 'mean' } });
    const absent = loadConfig(tuned, { model: { llm: { id: 'qwen3.5-4b' } } }, { env: {}, cwd });
    expect('embedding' in absent.config.model).toBe(false);
    expect(absent.origin['model.embedding.pooling']).toBe('default');
    // ...and inside a present block the default stands as any default does.
    const present = loadConfig(tuned, { model: { embedding: {} } }, { env: {}, cwd });
    expect(present.config.model.embedding).toEqual({ context: 2048, pooling: 'mean' });
  });

  it('a key set at the cli or in the environment makes its block, since it names a key of it', () => {
    const { config, origin } = loadConfig(modelSettings, {}, { cli: { reranker: '/r.gguf' }, env: {}, cwd });
    expect(config.model.reranker).toEqual({ path: '/r.gguf', context: 16384 });
    expect(origin['model.reranker.path']).toBe('cli');
  });

  it('a whitespace-only cli or env value is nothing: it neither makes the block nor sets the key — presence and acceptance read a value the same way', () => {
    // `--reranker "  "` used to make `{ reranker: { context: 16384 } }`, a block that then refused provisioning
    // for naming no model; the value that could not set the key must not request the block either.
    expect(loadConfig(modelSettings, {}, { cli: { reranker: '   ' }, env: {}, cwd }).config.model.reranker).toBeUndefined();
    const viaEnv = defineConfig({ 'model.llm.context': modelSettings['model.llm.context'], 'model.llm.id': modelSettings['model.llm.id'] });
    expect(loadConfig(viaEnv, {}, { env: { LLAMA_CTX_SIZE: ' ' }, cwd }).config.model.llm).toBeUndefined();
    // …and a padded value is the trimmed value, present.
    expect(loadConfig(modelSettings, {}, { cli: { reranker: ' /r.gguf ' }, env: {}, cwd }).config.model.reranker).toEqual({ path: '/r.gguf', context: 16384 });
  });

  it('a block a cli or env key made takes its defaults whatever the table declares first: presence is decided before any key is read', () => {
    // The default key BEFORE the key the cli supplies — the order that used to skip the default.
    const reversed = defineConfig({
      'model.reranker.context': modelSettings['model.reranker.context'],
      'model.reranker.path': modelSettings['model.reranker.path'],
      'model.llm.id': modelSettings['model.llm.id'],
    });
    expect(loadConfig(reversed, {}, { cli: { reranker: '/r.gguf' }, env: {}, cwd }).config.model.reranker).toEqual({ path: '/r.gguf', context: 16384 });
    const viaEnv = defineConfig({
      'model.llm.context': modelSettings['model.llm.context'],
      'model.llm.id': modelSettings['model.llm.id'],
    });
    expect(loadConfig(viaEnv, {}, { env: { LLAMA_CTX_SIZE: '8192' }, cwd }).config.model.llm).toEqual({ context: 8192 });
  });

  it('a scalar where a block belongs is loud from the committed rung and dropped from the local one — never silently absent', () => {
    expect(() => loadConfig(modelSettings, { model: { llm: { id: 'qwen3.5-4b' }, reranker: '' as unknown as object } }, { env: {}, cwd }))
      .toThrow('harness.yml: model.reranker must be a block of keys (got "")');
    expect(() => loadConfig(modelSettings, { model: { llm: { id: 'qwen3.5-4b' }, reranker: 'x' as unknown as object } }, { env: {}, cwd }))
      .toThrow(/model\.reranker must be a block of keys/);
    writeJson({ version: CONFIG_VERSION, sources: {}, abilities: {}, model: { reranker: 'x' } });
    const { config } = loadConfig(modelSettings, { model: { llm: { id: 'qwen3.5-4b' } } }, { env: {}, cwd });
    expect('reranker' in config.model).toBe(false);
  });

  it('`null` means one thing per file: in harness.json it is a clear, at a block as at a key — `{}` is the request there; a bare key is YAML\'s', () => {
    writeJson({ version: CONFIG_VERSION, sources: {}, abilities: {}, model: { vision: null } });
    expect(loadConfig(modelSettings, { model: { llm: { id: 'qwen3.5-4b' } } }, { env: {}, cwd }).config.model.vision).toBeUndefined();
    // A clear withdraws the overlay's word only: a block the committed file names stays requested.
    expect(loadConfig(modelSettings, { model: { llm: { id: 'qwen3.5-4b' }, vision: {} } }, { env: {}, cwd }).config.model.vision).toEqual({});
    writeJson({ version: CONFIG_VERSION, sources: {}, abilities: {}, model: { vision: {} } });
    expect(loadConfig(modelSettings, { model: { llm: { id: 'qwen3.5-4b' } } }, { env: {}, cwd }).config.model.vision).toEqual({});
  });

  it('a cli or env value the key REFUSES requests nothing: presence and acceptance are one rule', () => {
    const viaEnv = defineConfig({ 'model.llm.context': modelSettings['model.llm.context'], 'model.llm.id': modelSettings['model.llm.id'] });
    expect(loadConfig(viaEnv, {}, { env: { LLAMA_CTX_SIZE: '12k' }, cwd }).config.model.llm).toBeUndefined();
    expect(loadConfig(viaEnv, {}, { env: { LLAMA_CTX_SIZE: '8192' }, cwd }).config.model.llm).toEqual({ context: 8192 });
  });

  it("every top-level family the table declares is present, so an app reads `config.defaults` without a guard", () => {
    const own = defineConfig({ 'defaults.guards': { yml: 'defaults.guards', check: isGuardOverrides } });
    expect(loadConfig(own, {}, { env: {}, cwd }).config.defaults).toEqual({});
  });
});

describe("the app's keys (casework config.test.ts, ported)", () => {
  it('a committed defaults.guards loads, and survives a local effort save', () => {
    const yml = { defaults: { guards: GUARDS } };
    expect(loadConfig(app, yml, { env: {}, cwd }).config.defaults.guards).toEqual(GUARDS);
    saveLocalConfig(app, { defaults: { effort: 'medium' } }, cwd);
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
    writeJson({ version: CONFIG_VERSION, sources: {}, abilities: {}, defaults: { guards: { url_dedup: 'sometimes' } } });
    expect(loadConfig(app, { defaults: { guards: GUARDS } }, { env: {}, cwd }).config.defaults.guards).toEqual(GUARDS);
  });
});

describe('the rungs, and the provenance that falls out of them', () => {
  it('cli > env > harness.json > harness.yml > default, each reported as the rung it came from', () => {
    writeJson({ version: CONFIG_VERSION, sources: { outputDir: '/local' }, abilities: {}, model: { llm: { context: 2048 } } });
    const yml = { sources: { outputDir: '/yml' }, model: { llm: { context: 1024 } } };
    const a = loadConfig(app, yml, { cli: { outputDir: '/cli' }, env: { LLAMA_CTX_SIZE: '4096' }, cwd });
    expect(a.config.sources.outputDir).toBe('/cli');
    expect(a.origin['sources.outputDir']).toBe('cli');
    expect(a.config.model.llm?.context).toBe(4096);
    expect(a.origin['model.llm.context']).toBe('env');
    const b = loadConfig(app, yml, { env: {}, cwd });
    expect(b.config.sources.outputDir).toBe('/local');
    expect(b.origin['sources.outputDir']).toBe('file');
    expect(b.config.model.llm?.context).toBe(2048);
    fs.rmSync(path.join(cwd, 'harness.json'));
    const c = loadConfig(app, yml, { env: {}, cwd });
    expect(c.config.sources.outputDir).toBe('/yml');
    expect(c.origin['sources.outputDir']).toBe('yml');
    expect(c.config.model.llm?.context).toBe(1024);
    expect(c.origin['model.llm.context']).toBe('yml');
    const d = loadConfig(app, {}, { env: {}, cwd });
    expect(d.config.sources.outputDir).toBe(path.join(cwd, 'reports')); // the default is the app's: relative to its project
    expect(d.origin['sources.outputDir']).toBe('default');
    expect(d.config.defaults.effort).toBe('high');
    expect(d.origin['defaults.effort']).toBe('default');
    expect(d.config.model.llm).toBeUndefined();
    expect(d.origin['model.llm.context']).toBe('default');
    expect(d.loadedFromFile).toBe(false);
    expect(d.path).toBe(path.join(cwd, 'harness.json'));
  });

  it('an env value the key cannot take falls through, and so does a hand-edited local one', () => {
    writeJson({ version: CONFIG_VERSION, sources: {}, abilities: {}, model: { llm: { context: 'lots', gpu: 'tpu' } }, defaults: { effort: 'max' } });
    const { config, origin } = loadConfig(app, { model: { llm: { context: 1024, gpu: 'cuda' } }, defaults: { effort: 'low' } }, { env: { LLAMA_CTX_SIZE: '12k', LLOYAL_GPU: 'quantum' }, cwd });
    expect(config.model.llm?.context).toBe(1024);
    expect(origin['model.llm.context']).toBe('yml');
    expect(config.model.llm?.gpu).toBe('cuda');
    expect(config.defaults.effort).toBe('low');
  });

  it('an empty string is a clear at every rung: the value comes from the rung beneath', () => {
    writeJson({ version: CONFIG_VERSION, sources: { outputDir: '' }, abilities: {}, model: { llm: { path: '' } } });
    const { config, origin } = loadConfig(app, { sources: { outputDir: '/yml' }, model: { llm: { path: '/yml/model.gguf' } } }, { cli: { outputDir: '' }, env: {}, cwd });
    expect(config.sources.outputDir).toBe('/yml');
    expect(origin['sources.outputDir']).toBe('yml');
    expect(config.model.llm?.path).toBe('/yml/model.gguf');
  });

  it('a path key is expanded and made absolute at the boundary', () => {
    const { config } = loadConfig(app, { sources: { outputDir: '~/briefs' }, model: { llm: { path: './m.gguf' } } }, { env: {}, cwd });
    expect(config.sources.outputDir).toBe(path.join(os.homedir(), 'briefs'));
    expect(config.model.llm?.path).toBe(path.join(cwd, 'm.gguf'));
  });

  it('a relative path from a file, an ability block or the default resolves against the project; one typed at the cli or set in the environment, against the process', () => {
    const yml = { model: { llm: { path: './m.gguf' } }, abilities: { corpus: { corpusPath: './docs' } } } as never;
    const { config } = loadConfig(app, yml, { env: {}, cwd });
    expect(config.model.llm?.path).toBe(path.join(cwd, 'm.gguf'));
    expect(config.sources.outputDir).toBe(path.join(cwd, 'reports'));
    expect((config.abilities as Record<string, Record<string, unknown>>).corpus.corpusPath).toBe(path.join(cwd, 'docs'));
    writeJson({ version: CONFIG_VERSION, sources: { outputDir: './local' } });
    expect(loadConfig(app, {}, { env: {}, cwd }).config.sources.outputDir).toBe(path.join(cwd, 'local'));
    expect(loadConfig(app, {}, { env: {}, cwd, cli: { outputDir: './typed' } }).config.sources.outputDir).toBe(path.resolve('./typed'));
  });

  it('the committed rung fails loud, naming the yml path and what it takes', () => {
    writeYml('model:\n  llm:\n    gpu: tpu\n');
    expect(() => loadYml(app, cwd)).toThrow('harness.yml: model.llm.gpu must be default, cuda, or vulkan (got "tpu")');
    writeYml('model:\n  llm:\n    context: lots\n');
    expect(() => loadYml(app, cwd)).toThrow('harness.yml: model.llm.context must be a positive integer (got "lots")');
    writeYml('model:\n  reranker:\n    context: lots\n');
    expect(() => loadYml(app, cwd)).toThrow('harness.yml: model.reranker.context must be a positive integer (got "lots")');
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
    writeJson({ version: CONFIG_VERSION, sources: {}, abilities: { web: { tavilyKey: 'k' } } });
    const { config } = loadConfig(modelSettings, { abilities: { corpus: { corpusPath: './docs' }, web: { tavilyKey: 'committed', region: 'eu' } } }, { env: {}, cwd });
    expect(config.abilities).toEqual({ corpus: { corpusPath: path.join(cwd, 'docs') }, web: { tavilyKey: 'k' } });
  });
});

describe('a version-1 harness.json, which wrote the model keys flat', () => {
  const v1 = { version: 1, sources: {}, abilities: {}, model: { path: '/m.gguf', nCtx: 4096, gpu: 'cuda', reranker: '/r.gguf', rerankerId: 'qwen3-reranker-0.6b-q8', mmproj: 'qwen3.5-4b-mmproj', imageMaxTokens: 512 } };

  it('is read at the blocks its keys now live in — a previously selected model never vanishes from resolution', () => {
    writeJson(v1);
    const { config, origin } = loadConfig(app, {}, { env: {}, cwd });
    expect(config.model).toEqual({
      llm: { path: '/m.gguf', context: 4096, gpu: 'cuda' },
      reranker: { path: '/r.gguf', id: 'qwen3-reranker-0.6b-q8', context: 16384 },
      vision: { id: 'qwen3.5-4b-mmproj', maxTokens: 512 },
    });
    expect(origin['model.reranker.path']).toBe('file');
  });

  it('is rewritten at the current version on the first save, its keys migrated with it', () => {
    writeJson(v1);
    saveLocalConfig(app, { defaults: { effort: 'low' } }, cwd);
    expect(readJson()).toEqual({
      version: CONFIG_VERSION, sources: {}, abilities: {}, defaults: { effort: 'low' },
      model: { llm: { path: '/m.gguf', context: 4096, gpu: 'cuda' }, reranker: { path: '/r.gguf', id: 'qwen3-reranker-0.6b-q8' }, vision: { id: 'qwen3.5-4b-mmproj', maxTokens: 512 } },
    });
  });
});

describe('saveLocalConfig', () => {
  it('merges each family over the file — a block inside the model family too — clears on "", whole-replaces a named ability, keeps the rest', () => {
    writeJson({ version: CONFIG_VERSION, sources: { outputDir: '/old' }, abilities: { corpus: { corpusPath: '/c' }, web: { tavilyKey: 'k', region: 'eu' } }, model: { llm: { path: '/m', context: 1024 }, reranker: { id: 'r', context: 8192 } }, defaults: { effort: 'low', guards: GUARDS } });
    const result = saveLocalConfig(app, { sources: { outputDir: '' }, abilities: { web: { tavilyKey: 'k2' } }, model: { llm: { path: '', gpu: 'cuda' }, reranker: { id: 'r2' } }, defaults: { effort: 'medium' } }, cwd);
    expect(result.path).toBe(path.join(cwd, 'harness.json'));
    expect(readJson()).toEqual({
      version: CONFIG_VERSION,
      sources: {},
      abilities: { corpus: { corpusPath: '/c' }, web: { tavilyKey: 'k2' } },
      model: { llm: { context: 1024, gpu: 'cuda' }, reranker: { id: 'r2', context: 8192 } },
      defaults: { effort: 'medium', guards: GUARDS },
    });
  });

  it('an object-valued key is one value: a save of defaults.guards replaces it whole', () => {
    writeJson({ version: CONFIG_VERSION, sources: {}, abilities: {}, defaults: { guards: GUARDS } });
    saveLocalConfig(app, { defaults: { guards: { url_dedup: { scope: 'agent' } } } }, cwd);
    expect(readJson().defaults.guards).toEqual({ url_dedup: { scope: 'agent' } });
  });

  it('an empty block is a request, saved as the request it is; "" for a block withdraws it', () => {
    saveLocalConfig(app, { model: { vision: {} } }, cwd);
    expect(readJson().model).toEqual({ vision: {} });
    saveLocalConfig(app, { model: { vision: '' as never } }, cwd);
    expect(readJson().model).toEqual({});
  });

  it('a fresh file is written from the patch alone; a file it cannot understand is never rebuilt', () => {
    saveLocalConfig(app, { defaults: { effort: 'medium' } }, cwd);
    expect(readJson()).toEqual({ version: CONFIG_VERSION, sources: {}, abilities: {}, defaults: { effort: 'medium' } });
    writeJson({ version: CONFIG_VERSION + 1, defaults: { effort: 'ultra' } });
    expect(() => saveLocalConfig(app, { defaults: { effort: 'low' } }, cwd)).toThrow(new RegExp(`version ${CONFIG_VERSION + 1}`));
    expect(readJson()).toEqual({ version: CONFIG_VERSION + 1, defaults: { effort: 'ultra' } });
  });
});

// A generic app's table is not all dotted families. A scalar declared at the top level must
// persist as itself: the writer merges object families, and a leaf replaces.
describe('saveLocalConfig: a top-level scalar key', () => {
  const scalarApp = defineConfig({ ...modelSettings, maxRows: { yml: 'maxRows', integer: true, default: 10 } });

  it('persists as its value, not as an empty family', () => {
    const cfg = runnerConfig(scalarApp, {}, { env: {}, cwd });
    const runner = makeEdgeRunner(cfg.config, cfg);
    runner.saveConfig({ maxRows: 25 } as never);
    expect(readJson().maxRows).toBe(25);
    expect((runner.config() as { maxRows: number }).maxRows).toBe(25);
  });

  it('survives the next boot\'s re-layering', () => {
    const cfg = runnerConfig(scalarApp, {}, { env: {}, cwd });
    makeEdgeRunner(cfg.config, cfg).saveConfig({ maxRows: 25 } as never);
    const next = runnerConfig(scalarApp, {}, { env: {}, cwd });
    expect((next.config as { maxRows: number }).maxRows).toBe(25);
    expect(next.origin.maxRows).toBe('file');
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
    runner.saveConfig({ model: { llm: { context: 4096 } } });
    expect(runner.config().model.llm?.context).toBe(32768);
    expect(runner.origin()['model.llm.context']).toBe('yml');
    expect(readJson().model.llm.context).toBe(4096);
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

  it('a served session cannot make the reported model differ from the one running: the block stays boot-frozen, value and origin', () => {
    const cfg = runnerConfig(app, { model: { llm: { id: 'qwen3.5-4b', context: 32768 }, reranker: { id: 'r' } } }, { env: {}, cwd });
    const runner = makeServedRunner(cfg.config, cfg);
    const saved = runner.saveConfig({ model: { llm: { context: 4096 }, reranker: { id: 'other' }, vision: {} }, defaults: { effort: 'low' } });
    expect(saved.config.model).toEqual({ llm: { id: 'qwen3.5-4b', context: 32768 }, reranker: { id: 'r', context: 16384 } });
    expect(saved.origin['model.llm.context']).toBe('yml');
    expect(saved.origin['model.reranker.id']).toBe('yml');
    expect(saved.config.defaults.effort).toBe('low');
    expect(saved.origin['defaults.effort']).toBe('session');
  });
});

describe('defineConfig', () => {
  it('refuses the keys rig owns and a key that is both a leaf and a family', () => {
    expect(() => defineConfig({ version: { default: 2 } } as never)).toThrow(/version/);
    expect(() => defineConfig({ 'abilities.web': { yml: 'abilities.web' } })).toThrow(/abilities/);
    expect(() => defineConfig({ abilities: { yml: 'abilities' } })).toThrow(/abilities/);
    expect(() => defineConfig({ model: { default: {} }, 'model.llm.context': { integer: true } })).toThrow(/model/);
    expect(() => defineConfig({ 'model.reranker': { path: true }, 'model.reranker.id': {} })).toThrow(/model\.reranker/);
  });
});
