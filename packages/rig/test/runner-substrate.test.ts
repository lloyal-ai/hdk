/**
 * Runner substrate (hdk#109) — the generic factories instantiated with BOTH
 * shipped template shapes (research: defaults/reasoningMode; basic:
 * surface/id/sizeBytes), locking that `Runner<C, O>` fits each without casts.
 * The behaviors were live-proven across lloyal-ai#14's eight review rounds;
 * these pin them as permanent regressions.
 */
import { describe, it, expect } from 'vitest';
import {
  makeEdgeRunner,
  makeServedRunner,
  markSession,
  rung,
} from '../src/runner';
import type {
  BaseHarnessConfig,
  ConfigOriginValue,
  ConfigPatch,
  SaveResult,
} from '../src/runner';
import { defineConfig, mergeConfig, modelSettings, CONFIG_VERSION } from '../src/config';

// ── The two shipped template shapes ─────────────────────────────

const RESEARCH = defineConfig({
  ...modelSettings,
  'sources.outputDir': { yml: 'sources.outputDir', path: true },
  'defaults.reasoningMode': { yml: 'defaults.reasoningMode', oneOf: ['flat', 'deep'] },
});
interface ResearchConfig extends BaseHarnessConfig {
  defaults: { reasoningMode: 'flat' | 'deep'; effort: string; maxTurns: number };
  model: { llm?: { path?: string; context?: number; gpu?: string }; reranker?: { path?: string; id?: string } };
}
type ResearchOrigin = Record<
  'defaults.reasoningMode' | 'model.llm.path' | 'model.reranker.path' | 'model.llm.context' | 'model.llm.gpu' | 'sources.outputDir',
  ConfigOriginValue
>;
const RESEARCH_MAP = {
  'sources.outputDir': 'sources.outputDir',
  'model.llm.path': 'model.llm.path',
  'model.reranker.path': 'model.reranker.path',
  'model.llm.context': 'model.llm.context',
  'model.llm.gpu': 'model.llm.gpu',
  'defaults.reasoningMode': 'defaults.reasoningMode',
} as const;

const BASIC = defineConfig({ ...modelSettings, 'sources.outputDir': { yml: 'sources.outputDir', path: true }, surface: { yml: 'surface' } });
interface BasicConfig extends BaseHarnessConfig {
  surface?: string;
  model: { llm?: { path?: string; context?: number; gpu?: string; id?: string; sizeBytes?: number } };
}
type BasicOrigin = Record<
  'model.llm.path' | 'model.reranker.path' | 'model.llm.context' | 'model.llm.gpu' | 'sources.outputDir',
  ConfigOriginValue
>;

const researchCfg = (): ResearchConfig => ({
  version: CONFIG_VERSION,
  sources: {},
  abilities: {},
  defaults: { reasoningMode: 'flat', effort: 'high', maxTurns: 10 },
  model: { llm: { path: '/resolved/model.gguf', context: 32768, gpu: 'default' } },
});
const researchOrigin = (): ResearchOrigin => ({
  'defaults.reasoningMode': 'default', 'model.llm.path': 'yml', 'model.reranker.path': 'yml',
  'model.llm.context': 'yml', 'model.llm.gpu': 'env', 'sources.outputDir': 'default',
});
const researchOpts = () => ({ table: RESEARCH, origin: researchOrigin(), sessionOriginMap: RESEARCH_MAP });

describe('served runner (in-memory, per-session)', () => {
  it('clones per session; saves never share state or reach disk', () => {
    const cfg = researchCfg();
    const a = makeServedRunner(cfg, researchOpts());
    const b = makeServedRunner(cfg, researchOpts());
    const saved = a.saveConfig({ sources: { outputDir: '/a-only' } });
    expect(saved.path).toBeNull();
    expect(a.config().sources.outputDir).toBe('/a-only');
    expect(b.config().sources.outputDir).toBeUndefined();
    expect(cfg.sources.outputDir).toBeUndefined(); // the shared cfg untouched
  });

  it('marks touched fields `session` per the template map; the model block is the running residency and stays boot-frozen', () => {
    const r = makeServedRunner(researchCfg(), researchOpts());
    const saved = r.saveConfig({ defaults: { reasoningMode: 'deep' }, model: { llm: { gpu: 'cuda' } } });
    expect(saved.origin['defaults.reasoningMode']).toBe('session');
    expect(saved.config.defaults.reasoningMode).toBe('deep');
    expect(saved.origin['model.llm.gpu']).toBe('env');        // frozen: a session cannot change what runs
    expect(saved.config.model.llm?.gpu).toBe('default');
    expect(saved.origin['model.llm.path']).toBe('yml');       // untouched fields keep boot origin
  });

  it('drops an accidentally-passed persist — served never writes', () => {
    let wrote = 0;
    const r = makeServedRunner(researchCfg(), {
      ...researchOpts(),
      persist: () => { wrote++; return { path: '/x', gitignored: false, skipped: [], config: researchCfg(), origin: researchOrigin() }; },
    });
    const saved = r.saveConfig({ sources: { outputDir: '/t' } });
    r.reloadRuntime({ model: { llm: { gpu: 'cuda' } } });
    expect(wrote).toBe(0);
    expect(saved.path).toBeNull();
  });
});

describe('edge runner (persist + reconcile)', () => {
  const mkPersist = (relayered: ResearchConfig, origin: ResearchOrigin) => {
    const calls: ConfigPatch<ResearchConfig>[] = [];
    const persist = (patch: ConfigPatch<ResearchConfig>): SaveResult & { config: ResearchConfig; origin: ResearchOrigin } => {
      calls.push(patch);
      return { path: '/proj/harness.json', gitignored: false, skipped: [], config: relayered, origin };
    };
    return { persist, calls };
  };

  it('live-read fields reconcile from the relayer; the model block stays boot-frozen (value AND origin)', () => {
    const boot = researchCfg();
    // The relayer says: outputDir restored from yml, and a DIFFERENT model
    // path now on disk (for the NEXT boot) — the running model must not move.
    const relayered: ResearchConfig = {
      ...researchCfg(),
      sources: { outputDir: '/from-yml' },
      model: { llm: { path: '/next-boot.gguf', context: 16384, gpu: 'cuda' } },
    };
    const relayeredOrigin: ResearchOrigin = { ...researchOrigin(), 'sources.outputDir': 'yml', 'model.llm.path': 'file', 'model.llm.gpu': 'file' };
    const { persist } = mkPersist(relayered, relayeredOrigin);
    const r = makeEdgeRunner(boot, { ...researchOpts(), persist });

    const saved = r.saveConfig({ sources: { outputDir: '' } });
    expect(saved.path).toBe('/proj/harness.json');
    // live-read: relayered value + origin together
    expect(saved.config.sources.outputDir).toBe('/from-yml');
    expect(saved.origin['sources.outputDir']).toBe('yml');
    // boot-frozen: the RUNNING residency, value and origin
    expect(saved.config.model.llm?.path).toBe('/resolved/model.gguf');
    expect(saved.origin['model.llm.path']).toBe('yml');
    expect(saved.origin['model.llm.gpu']).toBe('env');
  });

  it('reloadRuntime persists the patch (reload-by-relaunch)', () => {
    const { persist, calls } = mkPersist(researchCfg(), researchOrigin());
    const r = makeEdgeRunner(researchCfg(), { ...researchOpts(), persist });
    r.reloadRuntime({ model: { llm: { path: '/new.gguf' } } });
    expect(calls).toEqual([{ model: { llm: { path: '/new.gguf' } } }]);
  });

  it('a frozen key ABSENT at boot stays absent — a relayered file cannot bring it live', () => {
    const boot: BasicConfig = {
      version: CONFIG_VERSION, sources: {}, abilities: {}, // no `surface` at boot
      model: { llm: { path: '/m.gguf' } },
    };
    const origin: BasicOrigin = { 'model.llm.path': 'yml', 'model.reranker.path': 'default', 'model.llm.context': 'default', 'model.llm.gpu': 'default', 'sources.outputDir': 'default' };
    const relayered: BasicConfig = {
      version: CONFIG_VERSION, sources: {}, abilities: {}, surface: 'web', // file introduces it
      model: { llm: { path: '/other.gguf' } },
    };
    const r = makeEdgeRunner(boot, {
      table: BASIC,
      origin,
      sessionOriginMap: { 'sources.outputDir': 'sources.outputDir' },
      persist: () => ({ path: '/p/harness.json', gitignored: false, skipped: [], config: relayered, origin }),
    });
    const saved = r.saveConfig({ sources: { outputDir: '/d' } });
    expect('surface' in saved.config).toBe(false);
    expect(saved.config.model.llm?.path).toBe('/m.gguf'); // frozen value also held
  });

  it('basic shape: `surface` is boot-frozen by default; absent keys ignored', () => {
    const boot: BasicConfig = {
      version: CONFIG_VERSION, sources: {}, abilities: {}, surface: 'cli',
      model: { llm: { path: '/m.gguf', id: 'qwen', sizeBytes: 42 } },
    };
    const origin: BasicOrigin = { 'model.llm.path': 'yml', 'model.reranker.path': 'default', 'model.llm.context': 'yml', 'model.llm.gpu': 'default', 'sources.outputDir': 'default' };
    const relayered: BasicConfig = { version: CONFIG_VERSION, sources: { outputDir: '/d' }, abilities: {}, model: {} };
    const r = makeEdgeRunner(boot, {
      table: BASIC,
      origin,
      sessionOriginMap: { 'sources.outputDir': 'sources.outputDir', 'model.llm.path': 'model.llm.path' },
      persist: () => ({ path: '/p/harness.json', gitignored: true, skipped: [], config: relayered, origin }),
    });
    const saved = r.saveConfig({ sources: { outputDir: '/d' } });
    expect(saved.config.surface).toBe('cli');           // frozen, though relayer omitted it
    expect(saved.config.model.llm?.id).toBe('qwen');    // measured boot facts survive
    expect(saved.gitignored).toBe(true);
  });
});

describe('mergeConfig / markSession / rung', () => {
  it('merges into the families the table declares, however deep; abilities whole-replace per name; "" clears; never mutates base', () => {
    const base = researchCfg();
    base.sources.outputDir = '/old';
    base.abilities = { web: { tavilyKey: 'k' }, corpus: { corpusPath: '/c' } };
    base.model.reranker = { id: 'r', path: '/r.gguf' };
    const next = mergeConfig(RESEARCH, base, {
      sources: { outputDir: '' },
      abilities: { web: {} },
      defaults: { reasoningMode: 'deep' },
      model: { reranker: { id: 'r2' } },
    });
    expect(next.sources.outputDir).toBeUndefined();
    expect(next.abilities.web).toEqual({});             // whole-replace
    expect(next.abilities.corpus).toEqual({ corpusPath: '/c' }); // others survive
    expect(next.defaults.effort).toBe('high');          // per-key defaults merge
    expect(next.defaults.reasoningMode).toBe('deep');
    expect(next.model.reranker).toEqual({ id: 'r2', path: '/r.gguf' }); // a block merges: the table says it holds keys
    expect(next.model.llm?.path).toBe('/resolved/model.gguf');          // its sibling block untouched
    expect(base.sources.outputDir).toBe('/old');        // base untouched
    expect(base.model.reranker).toEqual({ id: 'r', path: '/r.gguf' });
  });

  it('a key the table declares as one value — an object, an array — is replaced whole, not merged into', () => {
    const table = defineConfig({ 'defaults.guards': { yml: 'defaults.guards' }, tags: { yml: 'tags' } });
    type Cfg = BaseHarnessConfig & { defaults: { guards?: Record<string, unknown> }; tags?: string[] };
    const base: Cfg = { version: CONFIG_VERSION, sources: {}, abilities: {}, model: {}, defaults: { guards: { url_dedup: { scope: 'cohort' }, query_dedup: { scope: 'cohort' } } }, tags: ['a', 'b'] };
    const next = mergeConfig(table, base, { defaults: { guards: { url_dedup: { scope: 'agent' } } }, tags: ['c'] });
    expect(next.defaults.guards).toEqual({ url_dedup: { scope: 'agent' } });
    expect(next.tags).toEqual(['c']);
  });

  it('markSession sees a cleared key ("" is present) at any depth, and unknown paths are inert', () => {
    const o = researchOrigin();
    const next = markSession<ResearchConfig, ResearchOrigin>(
      o, { sources: { outputDir: '' }, model: { llm: { gpu: '' } } }, RESEARCH_MAP,
    );
    expect(next['sources.outputDir']).toBe('session');
    expect(next['model.llm.gpu']).toBe('session');
    expect(o['sources.outputDir']).toBe('default'); // input not mutated
  });

  it('rung mirrors ?? exactly — null claims no rung', () => {
    expect(rung(undefined, undefined, null, 42)).toBe('yml');
    expect(rung(undefined, 0, null, 42)).toBe('env');   // 0 is a value
    expect(rung(null, null, null, null)).toBe('default');
    expect(rung<unknown>('x', 1, 'f', 'y')).toBe('cli');
  });
});
