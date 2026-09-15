/**
 * `settings`, the one rig default: three commands in place of a template's eight,
 * over the Runner's knobs. A save carries only what changed and is announced with
 * ability values redacted; an ability's configuration persists first, enables
 * second, and restores every surface it touched when the enable fails; nothing
 * about an ability changes while a run is live; a runtime change persists and
 * ends the loop.
 */
import { describe, it, expect, vi } from 'vitest';
import { run } from 'effection';
import type { Operation } from 'effection';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAbilityRegistry } from '../src/registry';
import { createInMemoryConfigStore } from '../src/config-store';
import { makeServedRunner, makeEdgeRunner } from '../src/runner';
import type { ConfigPatch, SaveResult } from '../src/runner';
import { defineConfig, modelSettings } from '../src/config';
import { settings } from '../src/settings';
import type { SettingsCommand, SettingsEvent } from '../src/settings-protocol';
import type { JsonSchema } from '@lloyal-labs/lloyal-agents';
import { fakeAbility } from './helpers/fake-ability';

const table = defineConfig({ ...modelSettings, 'sources.outputDir': { yml: 'sources.outputDir', path: true, default: 'reports' } });
type Config = { version: 1; sources: { outputDir?: string }; abilities: Record<string, Record<string, unknown>>; model: Record<string, unknown> };
const base = (abilities: Record<string, Record<string, unknown>> = {}): Config => ({ version: 1, sources: { outputDir: '/out' }, abilities, model: {} });
const origin = { 'sources.outputDir': 'yml' as const };
const identity = { 'sources.outputDir': 'sources.outputDir' as const };

/** A served runner, a real registry and store, one fake ability, the group over them. */
function* world(opts: {
  abilities: ReturnType<typeof fakeAbility>[];
  config?: Config;
  busy?: boolean;
  persist?: (patch: ConfigPatch<Config>) => SaveResult & { config: Config; origin: typeof origin };
  enable?: string[];
}) {
  const sent: SettingsEvent[] = [];
  const cfg = opts.config ?? base();
  const runner = opts.persist
    ? makeEdgeRunner<Config, typeof origin>(cfg, { origin, sessionOriginMap: identity, persist: opts.persist })
    : makeServedRunner<Config, typeof origin>(cfg, { origin, sessionOriginMap: identity });
  const store = createInMemoryConfigStore();
  for (const [name, c] of Object.entries(cfg.abilities)) yield* store.set(name, c);
  const registry = yield* createAbilityRegistry({ configStore: store });
  for (const name of opts.enable ?? []) yield* registry.enable(opts.abilities.find((a) => a.manifest!.name === name)!);
  const wire = { *send(e: SettingsEvent): Operation<void> { sent.push(e); } };
  const group = settings({ runner, registry, store, wire, run: { busy: opts.busy ?? false }, abilities: opts.abilities, config: table });
  return { sent, runner, store, registry, handlers: group.handlers };
}
const dispatch = (w: { handlers: ReturnType<typeof settings>['handlers'] }, c: SettingsCommand) =>
  (w.handlers[c.type] as (c: SettingsCommand) => Operation<'exit' | void>)(c);

describe('set_config', () => {
  it('saves only what changed and announces it with ability values redacted; a path key is resolved', async () => {
    await run(function* () {
      const w = yield* world({ abilities: [], config: base({ web: { tavilyKey: 'secret' } }) });
      const flow = yield* dispatch(w, { type: 'set_config', patch: { sources: { outputDir: '~/briefs' } } });
      expect(flow).toBeUndefined();
      expect(w.runner.config().sources.outputDir).toBe(path.join(os.homedir(), 'briefs'));
      expect(w.sent).toEqual([{
        type: 'config:updated',
        config: { ...w.runner.config(), abilities: { web: { tavilyKey: true } } },
        origin: { 'sources.outputDir': 'session' },
        savedTo: null, gitignored: false, skipped: [],
      }]);
    });
  });
});

describe('set_ability_config', () => {
  const REQUIRED: JsonSchema = { type: 'object', required: ['corpusPath'], properties: { corpusPath: { type: 'string' } } };

  it('is refused with a toast while a run is live; nothing changes', async () => {
    await run(function* () {
      const web = fakeAbility({ name: 'web' });
      const w = yield* world({ abilities: [web], busy: true });
      yield* dispatch(w, { type: 'set_ability_config', name: 'web', values: { tavilyKey: 'k' } });
      expect(w.sent).toEqual([{ type: 'ui:error', message: expect.stringMatching(/run|brief|settle/i) }]);
      expect(yield* w.store.get('web')).toBeUndefined();
      expect(w.runner.config().abilities).toEqual({});
    });
  });

  it('persists first, then enables; announces config:updated then abilities:state', async () => {
    await run(function* () {
      const seen: unknown[] = [];
      const web = fakeAbility({ name: 'web', saw: (c) => seen.push(c) });
      const w = yield* world({ abilities: [web], enable: ['web'] });
      yield* dispatch(w, { type: 'set_ability_config', name: 'web', values: { tavilyKey: 'k' } });
      expect(w.runner.config().abilities.web).toEqual({ tavilyKey: 'k' });
      expect(yield* w.store.get('web')).toEqual({ tavilyKey: 'k' });
      expect(seen).toEqual([undefined, { tavilyKey: 'k' }]);
      expect(w.registry.stateOf('web')).toBe('enabled');
      expect(w.sent.map((e) => e.type)).toEqual(['config:updated', 'abilities:state']);
      const state = w.sent[1] as Extract<SettingsEvent, { type: 'abilities:state' }>;
      expect(state.abilities).toEqual([expect.objectContaining({ name: 'web', enabled: true, config: { tavilyKey: true } })]);
    });
  });

  it('an enable that fails restores the store, the live instance and the saved config, and says why', async () => {
    await run(function* () {
      const good = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-'));
      const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-bad-'));
      // The bad dir exists, so the existence check passes; the factory refuses it, so the enable fails.
      const refuse = fakeAbility({ name: 'corpus', configSchema: REQUIRED, refuse: (c) => (c?.corpusPath === bad ? 'no index there' : undefined) });
      const w2 = yield* world({ abilities: [refuse], config: base({ corpus: { corpusPath: good } }), enable: ['corpus'] });
      yield* dispatch(w2, { type: 'set_ability_config', name: 'corpus', values: { corpusPath: bad } });
      expect(yield* w2.store.get('corpus')).toEqual({ corpusPath: good });
      expect(w2.registry.stateOf('corpus')).toBe('enabled');
      expect(w2.runner.config().abilities.corpus).toEqual({ corpusPath: good });
      expect(w2.sent).toEqual([
        { type: 'abilities:state', abilities: [expect.objectContaining({ name: 'corpus', enabled: true, config: { corpusPath: true } })] },
        { type: 'ui:error', message: 'Cannot configure corpus: no index there' },
      ]);
    });
  });

  // A restore the interface never hears about is not a restore: the renderer holds the
  // roster it was last told, so the surfaces the command put back must be announced.
  it('a failed enable announces the restored state, not only the error', async () => {
    await run(function* () {
      const flaky = fakeAbility({ name: 'web', refuse: (c) => (c?.tavilyKey === 'bad' ? 'that key is refused' : undefined) });
      const w = yield* world({ abilities: [flaky], config: base(), enable: ['web'] });
      yield* dispatch(w, { type: 'set_ability_config', name: 'web', values: { tavilyKey: 'bad' } });
      expect(w.sent.map((e) => e.type)).toEqual(['abilities:state', 'ui:error']);
      const state = w.sent[0] as Extract<SettingsEvent, { type: 'abilities:state' }>;
      expect(state.abilities).toEqual([expect.objectContaining({ name: 'web', enabled: true, config: {} })]);
    });
  });

  // The restore above is conditional on a prior NONEMPTY config. An ability enabled on its
  // defaults has nothing stored, so a failed reconfiguration must not be able to leave it
  // disabled: prior enablement is a fact of its own, independent of config presence.
  it('an enable that fails restores an ability that had NO stored config', async () => {
    await run(function* () {
      const flaky = fakeAbility({ name: 'web', refuse: (c) => (c?.tavilyKey === 'bad' ? 'that key is refused' : undefined) });
      const w = yield* world({ abilities: [flaky], config: base(), enable: ['web'] });
      expect(w.registry.stateOf('web')).toBe('enabled');
      yield* dispatch(w, { type: 'set_ability_config', name: 'web', values: { tavilyKey: 'bad' } });
      expect(w.sent).toEqual([
        { type: 'abilities:state', abilities: [expect.objectContaining({ name: 'web', enabled: true })] },
        { type: 'ui:error', message: 'Cannot configure web: that key is refused' },
      ]);
      expect(w.registry.stateOf('web')).toBe('enabled');
    });
  });

  it('a path that does not exist is refused before anything persists', async () => {
    await run(function* () {
      const corpus = fakeAbility({ name: 'corpus', configSchema: REQUIRED });
      const w = yield* world({ abilities: [corpus] });
      yield* dispatch(w, { type: 'set_ability_config', name: 'corpus', values: { corpusPath: '/no/such/dir' } });
      expect(w.sent).toEqual([{ type: 'ui:error', message: 'corpusPath: path does not exist — /no/such/dir' }]);
      expect(w.runner.config().abilities).toEqual({});
    });
  });

  it('clearing a required-config ability disables it; clearing a config-less one re-enables it', async () => {
    await run(function* () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-'));
      const corpus = fakeAbility({ name: 'corpus', configSchema: REQUIRED });
      const web = fakeAbility({ name: 'web' });
      const w = yield* world({ abilities: [corpus, web], config: base({ corpus: { corpusPath: dir }, web: { tavilyKey: 'k' } }), enable: ['corpus', 'web'] });
      yield* dispatch(w, { type: 'set_ability_config', name: 'corpus', values: {} });
      expect(w.registry.stateOf('corpus')).toBe('disabled');
      expect(yield* w.store.get('corpus')).toBeUndefined();
      expect(w.runner.config().abilities.corpus).toEqual({});
      yield* dispatch(w, { type: 'set_ability_config', name: 'web', values: {} });
      expect(w.registry.stateOf('web')).toBe('enabled');
      expect(yield* w.store.get('web')).toEqual({});
    });
  });
});

describe('set_ability_config merges over what is stored', () => {
  it('a key the renderer never saw (a redacted secret) survives a save of its siblings; "" clears one key; {} clears all', async () => {
    await run(function* () {
      const web = fakeAbility({ name: 'web' });
      const w = yield* world({ abilities: [web], config: base({ web: { tavilyKey: 'secret', region: 'eu' } }), enable: ['web'] });
      yield* dispatch(w, { type: 'set_ability_config', name: 'web', values: { region: 'us' } });
      expect(yield* w.store.get('web')).toEqual({ tavilyKey: 'secret', region: 'us' });
      expect(w.runner.config().abilities.web).toEqual({ tavilyKey: 'secret', region: 'us' });
      yield* dispatch(w, { type: 'set_ability_config', name: 'web', values: { tavilyKey: '' } });
      expect(yield* w.store.get('web')).toEqual({ region: 'us' });
      yield* dispatch(w, { type: 'set_ability_config', name: 'web', values: {} });
      expect(yield* w.store.get('web')).toEqual({});
    });
  });
});

describe('reload_runtime', () => {
  it('a served session cannot reload the runtime: refused, and the session is NOT ended', async () => {
    // The server picks its model when it starts and serves every session from that one residency.
    // A session's reload persists nothing and rebuilds nothing, so returning "exit" would take a
    // working session away in exchange for no change at all — and the reader, seeing the page go,
    // would reasonably read it as the change having taken.
    await run(function* () {
      const w = yield* world({ abilities: [] });   // no `persist`: the served runner
      const flow = yield* dispatch(w, { type: 'reload_runtime', patch: { model: { gpu: 'cuda' } } });
      expect(flow, 'the session ended for a change that was never applied').toBeUndefined();
      expect(w.sent.map((e) => e.type)).toEqual(['ui:error']);
      expect((w.sent[0] as { type: 'ui:error'; message: string }).message).toMatch(/server/i);
    });
  });

  it('persists the patch and ends the loop', async () => {
    await run(function* () {
      const persist = vi.fn((patch: ConfigPatch<Config>) => ({ path: '/p', gitignored: false, skipped: [], config: base(), origin }));
      const w = yield* world({ abilities: [], persist });
      const flow = yield* dispatch(w, { type: 'reload_runtime', patch: { model: { gpu: 'cuda' } } });
      expect(flow).toBe('exit');
      expect(persist).toHaveBeenCalledWith({ model: { gpu: 'cuda' } });
      expect(w.sent).toEqual([]);
    });
  });
});
