/**
 * `initializeHarness`: the caller-scope initializer in `initAgents`'s shape. It
 * runs `initAgents`, installs the replay trunk, publishes the Runner's signals
 * and the pool's defaults, seeds the config store, creates the registry and
 * enables every declared ability whose required config is present, reporting
 * the ones that failed. It establishes the forwarder's subscription BEFORE it
 * returns, then says `config:loaded` and `abilities:state` itself — the first
 * two events on the wire. It owns the session; whoever created the context owns
 * the context.
 */
import { describe, it, expect } from 'vitest';
import { run, scoped, sleep } from 'effection';
import type { Operation } from 'effection';
import { MockSessionContext } from '../../sdk/src/testing.js';
import type { SessionContext } from '@lloyal-labs/sdk';
import { WindDown, CancelAgent, Pause, PoolDefaults, NSeqMax } from '@lloyal-labs/lloyal-agents';
import { makeServedRunner, RunnerCtx } from '../src/runner';
import { defineConfig, modelSettings, CONFIG_VERSION } from '../src/config';
import { initializeHarness } from '../src/initialize-harness';
import { useWire } from '../src/wire';
import type { SettingsEvent } from '../src/settings-protocol';
import type { JsonSchema } from '@lloyal-labs/lloyal-agents';
import { fakeAbility } from './helpers/fake-ability';

const table = defineConfig({ ...modelSettings, 'sources.outputDir': { yml: 'sources.outputDir', path: true, default: 'reports' } });
type Config = { version: typeof CONFIG_VERSION; sources: { outputDir?: string }; abilities: Record<string, Record<string, unknown>>; model: Record<string, unknown> };
type Event = SettingsEvent | { type: 'hello' };
const REQUIRED: JsonSchema = { type: 'object', required: ['corpusPath'], properties: { corpusPath: { type: 'string' } } };

function boot(abilities: Record<string, Record<string, unknown>> = {}, dev = false) {
  const ctx = new MockSessionContext({ nCtx: 8192 });
  const cfg: Config = { version: CONFIG_VERSION, sources: { outputDir: '/out' }, abilities, model: {} };
  const runner = makeServedRunner<Config, { 'sources.outputDir': 'yml' }>(cfg, { table, origin: { 'sources.outputDir': 'yml' }, sessionOriginMap: { 'sources.outputDir': 'sources.outputDir' }, dev });
  const events: Event[] = [];
  const bus = { send: (e: Event) => { events.push(e); } };
  return { ctx, runner, events, bus };
}

describe('initializeHarness', () => {
  it('subscribes the forwarder before returning, and says config:loaded then abilities:state first', async () => {
    const { ctx, runner, events, bus } = boot({ web: { tavilyKey: 'secret' } }, true);
    const web = fakeAbility({ name: 'web' });
    await run(function* () {
      yield* RunnerCtx.set(runner);
      const h = yield* initializeHarness(ctx as unknown as SessionContext, bus, { abilities: [web], config: table });
      yield* h.wire.send({ type: 'hello' });
      yield* sleep(0);
      expect(h.runner).toBe(runner);
      expect(h.disabled).toEqual([]);
      expect(events.map((e) => e.type)).toEqual(['config:loaded', 'abilities:state', 'hello']);
      const loaded = events[0] as Extract<SettingsEvent, { type: 'config:loaded' }>;
      expect(loaded.config.abilities).toEqual({ web: { tavilyKey: true } });   // redacted
      expect(loaded.dev).toBe(true);
      expect(loaded.origin).toEqual({ 'sources.outputDir': 'yml' });
      const state = events[1] as Extract<SettingsEvent, { type: 'abilities:state' }>;
      expect(state.abilities).toEqual([expect.objectContaining({ name: 'web', enabled: true })]);
      expect(yield* h.store.get('web')).toEqual({ tavilyKey: 'secret' });     // seeded, unredacted, server-side
      expect(h.registry.stateOf('web')).toBe('enabled');
      expect(yield* useWire<Event>()).toBe(h.wire);
    });
  });

  it('enables what can enable; an ability needing config it lacks is left out quietly; a failing one is reported', async () => {
    const { ctx, runner, bus } = boot();
    const corpus = fakeAbility({ name: 'corpus', configSchema: REQUIRED });
    const broken = fakeAbility({ name: 'broken', refuse: () => 'the service is down' });
    const web = fakeAbility({ name: 'web' });
    await run(function* () {
      yield* RunnerCtx.set(runner);
      const h = yield* initializeHarness(ctx as unknown as SessionContext, bus, { abilities: [corpus, broken, web], config: table });
      expect(h.registry.enabled().map((a) => a.name)).toEqual(['web']);
      expect(h.disabled).toEqual([{ name: 'broken', reason: 'the service is down' }]);
    });
  });

  it('publishes the Runner\'s signals, the pool defaults from `dev`, and the carried nSeqMax', async () => {
    const { ctx, runner, bus } = boot({}, true);
    await run(function* () {
      yield* RunnerCtx.set(runner);
      yield* initializeHarness(ctx as unknown as SessionContext, bus, { abilities: [], config: table, nSeqMax: 5 });
      expect(yield* WindDown.get()).toBe(runner.windDown);
      expect(yield* CancelAgent.get()).toBe(runner.cancelAgent);
      expect(yield* Pause.get()).toBe(runner.pauseRun);
      expect(yield* PoolDefaults.expect()).toEqual({ trace: true, pruneOnReturn: true });
      expect(yield* NSeqMax.get()).toBe(5);
    });
  });

  it('owns the session, never the context: the boot or host that made the context disposes it', async () => {
    const { ctx, runner, bus } = boot();
    await run(function* () {
      yield* RunnerCtx.set(runner);
      yield* scoped(function* (): Operation<void> {
        yield* initializeHarness(ctx as unknown as SessionContext, bus, { abilities: [], config: table });
      });
      expect(ctx.disposeCount).toBe(0);
    });
  });
});
