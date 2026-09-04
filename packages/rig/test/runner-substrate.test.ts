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
  mergeConfig,
  markSession,
  rung,
} from '../src/runner';
import type {
  BaseHarnessConfig,
  ConfigOriginValue,
  ConfigPatch,
  SaveResult,
} from '../src/runner';

// ── The two shipped template shapes ─────────────────────────────

interface ResearchConfig extends BaseHarnessConfig {
  defaults: { reasoningMode: 'flat' | 'deep'; effort: string; maxTurns: number };
  model: { path?: string; reranker?: string; nCtx?: number; gpu?: string };
}
type ResearchOrigin = Record<
  'reasoningMode' | 'modelPath' | 'reranker' | 'nCtx' | 'gpu' | 'outputDir',
  ConfigOriginValue
>;
const RESEARCH_MAP = {
  'sources.outputDir': 'outputDir',
  'model.path': 'modelPath',
  'model.reranker': 'reranker',
  'model.nCtx': 'nCtx',
  'model.gpu': 'gpu',
  'defaults.reasoningMode': 'reasoningMode',
} as const;

interface BasicConfig extends BaseHarnessConfig {
  surface?: string;
  model: { path?: string; nCtx?: number; gpu?: string; id?: string; sizeBytes?: number };
}
type BasicOrigin = Record<
  'modelPath' | 'reranker' | 'nCtx' | 'gpu' | 'outputDir',
  ConfigOriginValue
>;

const researchCfg = (): ResearchConfig => ({
  version: 1,
  sources: {},
  abilities: {},
  defaults: { reasoningMode: 'flat', effort: 'high', maxTurns: 10 },
  model: { path: '/resolved/model.gguf', nCtx: 32768, gpu: 'default' },
});
const researchOrigin = (): ResearchOrigin => ({
  reasoningMode: 'default', modelPath: 'yml', reranker: 'yml',
  nCtx: 'yml', gpu: 'env', outputDir: 'default',
});

describe('served runner (in-memory, per-session)', () => {
  it('clones per session; saves never share state or reach disk', () => {
    const cfg = researchCfg();
    const a = makeServedRunner(cfg, { origin: researchOrigin(), sessionOriginMap: RESEARCH_MAP });
    const b = makeServedRunner(cfg, { origin: researchOrigin(), sessionOriginMap: RESEARCH_MAP });
    const saved = a.saveConfig({ sources: { outputDir: '/a-only' } });
    expect(saved.path).toBeNull();
    expect(a.config().sources.outputDir).toBe('/a-only');
    expect(b.config().sources.outputDir).toBeUndefined();
    expect(cfg.sources.outputDir).toBeUndefined(); // the shared cfg untouched
  });

  it('marks touched fields `session` per the template map', () => {
    const r = makeServedRunner(researchCfg(), {
      origin: researchOrigin(), sessionOriginMap: RESEARCH_MAP,
    });
    const saved = r.saveConfig({ defaults: { reasoningMode: 'deep' }, model: { gpu: 'cuda' } });
    expect(saved.origin.reasoningMode).toBe('session');
    expect(saved.origin.gpu).toBe('session');
    expect(saved.origin.modelPath).toBe('yml'); // untouched fields keep boot origin
  });

  it('drops an accidentally-passed persist — served never writes', () => {
    let wrote = 0;
    const r = makeServedRunner(researchCfg(), {
      origin: researchOrigin(),
      sessionOriginMap: RESEARCH_MAP,
      persist: () => { wrote++; return { path: '/x', gitignored: false, skipped: [], config: researchCfg(), origin: researchOrigin() }; },
    });
    const saved = r.saveConfig({ sources: { outputDir: '/t' } });
    r.reloadRuntime({ model: { gpu: 'cuda' } });
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
      model: { path: '/next-boot.gguf', nCtx: 16384, gpu: 'cuda' },
    };
    const relayeredOrigin: ResearchOrigin = { ...researchOrigin(), outputDir: 'yml', modelPath: 'file', gpu: 'file' };
    const { persist } = mkPersist(relayered, relayeredOrigin);
    const r = makeEdgeRunner(boot, { origin: researchOrigin(), sessionOriginMap: RESEARCH_MAP, persist });

    const saved = r.saveConfig({ sources: { outputDir: '' } });
    expect(saved.path).toBe('/proj/harness.json');
    // live-read: relayered value + origin together
    expect(saved.config.sources.outputDir).toBe('/from-yml');
    expect(saved.origin.outputDir).toBe('yml');
    // boot-frozen: the RUNNING residency, value and origin
    expect(saved.config.model.path).toBe('/resolved/model.gguf');
    expect(saved.origin.modelPath).toBe('yml');
    expect(saved.origin.gpu).toBe('env');
  });

  it('reloadRuntime persists the patch (reload-by-relaunch)', () => {
    const { persist, calls } = mkPersist(researchCfg(), researchOrigin());
    const r = makeEdgeRunner(researchCfg(), { origin: researchOrigin(), sessionOriginMap: RESEARCH_MAP, persist });
    r.reloadRuntime({ model: { path: '/new.gguf' } });
    expect(calls).toEqual([{ model: { path: '/new.gguf' } }]);
  });

  it('a frozen key ABSENT at boot stays absent — a relayered file cannot bring it live', () => {
    const boot: BasicConfig = {
      version: 1, sources: {}, abilities: {}, // no `surface` at boot
      model: { path: '/m.gguf' },
    };
    const origin: BasicOrigin = { modelPath: 'yml', reranker: 'default', nCtx: 'default', gpu: 'default', outputDir: 'default' };
    const relayered: BasicConfig = {
      version: 1, sources: {}, abilities: {}, surface: 'web', // file introduces it
      model: { path: '/other.gguf' },
    };
    const r = makeEdgeRunner(boot, {
      origin,
      sessionOriginMap: { 'sources.outputDir': 'outputDir' },
      persist: () => ({ path: '/p/harness.json', gitignored: false, skipped: [], config: relayered, origin }),
    });
    const saved = r.saveConfig({ sources: { outputDir: '/d' } });
    expect('surface' in saved.config).toBe(false);
    expect(saved.config.model.path).toBe('/m.gguf'); // frozen value also held
  });

  it('basic shape: `surface` is boot-frozen by default; absent keys ignored', () => {
    const boot: BasicConfig = {
      version: 1, sources: {}, abilities: {}, surface: 'cli',
      model: { path: '/m.gguf', id: 'qwen', sizeBytes: 42 },
    };
    const origin: BasicOrigin = { modelPath: 'yml', reranker: 'default', nCtx: 'yml', gpu: 'default', outputDir: 'default' };
    const relayered: BasicConfig = { version: 1, sources: { outputDir: '/d' }, abilities: {}, model: {} };
    const r = makeEdgeRunner(boot, {
      origin,
      sessionOriginMap: { 'sources.outputDir': 'outputDir', 'model.path': 'modelPath' },
      persist: () => ({ path: '/p/harness.json', gitignored: true, skipped: [], config: relayered, origin }),
    });
    const saved = r.saveConfig({ sources: { outputDir: '/d' } });
    expect(saved.config.surface).toBe('cli');           // frozen, though relayer omitted it
    expect(saved.config.model.id).toBe('qwen');         // measured boot facts survive
    expect(saved.gitignored).toBe(true);
  });
});

describe('mergeConfig / markSession / rung', () => {
  it('merges one level deep; abilities whole-replace per name; "" clears outputDir; never mutates base', () => {
    const base = researchCfg();
    base.sources.outputDir = '/old';
    base.abilities = { web: { tavilyKey: 'k' }, corpus: { corpusPath: '/c' } };
    const next = mergeConfig(base, {
      sources: { outputDir: '' },
      abilities: { web: {} },
      defaults: { reasoningMode: 'deep' },
    });
    expect(next.sources.outputDir).toBeUndefined();
    expect(next.abilities.web).toEqual({});             // whole-replace
    expect(next.abilities.corpus).toEqual({ corpusPath: '/c' }); // others survive
    expect(next.defaults.effort).toBe('high');          // per-key defaults merge
    expect(next.defaults.reasoningMode).toBe('deep');
    expect(base.sources.outputDir).toBe('/old');        // base untouched
  });

  it('markSession sees a cleared key ("" is present) and unknown paths are inert', () => {
    const o = researchOrigin();
    const next = markSession<ResearchConfig, ResearchOrigin>(
      o, { sources: { outputDir: '' } }, RESEARCH_MAP,
    );
    expect(next.outputDir).toBe('session');
    expect(o.outputDir).toBe('default'); // input not mutated
  });

  it('rung mirrors ?? exactly — null claims no rung', () => {
    expect(rung(undefined, undefined, null, 42)).toBe('yml');
    expect(rung(undefined, 0, null, 42)).toBe('env');   // 0 is a value
    expect(rung(null, null, null, null)).toBe('default');
    expect(rung<unknown>('x', 1, 'f', 'y')).toBe('cli');
  });
});
