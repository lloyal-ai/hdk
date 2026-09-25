/**
 * R1–R4: an ability reconfigured while a run is live.
 *
 * A save applies at once (R1): the new entry is registered and the name resolves to it (R2); an agent that
 * spread the ability's tools before the save keeps working on the entry it took (R3); the superseded
 * entry's scope ends when the run that held it ends, once — and at once when no run holds it (R4).
 * This is what a Tavily key saved under a rate-limited run did before the busy gate; it is written here so
 * the platform promises it for every ability rather than one. Nobody asks whether a run is live: the run
 * holds what `participating()` handed it, for its own scope's life.
 */
import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import { world, numberedAbility } from '../harness';
import type { Enable, EnableTool } from '../harness';

const enableOf = (ability: { tools: readonly unknown[] }): number => (ability.tools[0] as EnableTool).nth;

/** A live run that took its sources, an agent that already spread their tools, then the save. */
function* reconfiguredUnderARun() {
  const built: Enable[] = [];
  const torn: number[] = [];
  const web = numberedAbility({ name: 'web', built, torn });
  const w = yield* world({ abilities: [web], enable: ['web'] });
  const running = yield* w.startRun();
  const handle = running.sources[0];
  const spread = [...handle.tools] as EnableTool[];   // an agent's tools, taken at its spawn
  yield* w.dispatch({ type: 'set_ability_config', name: 'web', values: { tavilyKey: 'k' } });
  return { w, running, handle, spread, built, torn };
}

describe('an ability reconfigured under a run', () => {
  it('R1 — the save applies while the run is live: persisted, stored, announced; nothing is refused', async () => {
    await run(function* () {
      const { w, built } = yield* reconfiguredUnderARun();
      expect(w.sent.map((e) => e.type)).toEqual(['config:updated', 'abilities:state']);
      expect(yield* w.store.get('web')).toEqual({ tavilyKey: 'k' });
      expect(built).toEqual([{ nth: 1, config: undefined }, { nth: 2, config: { tavilyKey: 'k' } }]);
    });
  });

  it('R2 — the name resolves to its current entry through one handle: the object the run took is the object that now answers the new tools', async () => {
    await run(function* () {
      const { w, handle } = yield* reconfiguredUnderARun();
      expect(w.registry.byName('web')).toBe(handle);
      expect(w.registry.enabled()[0]).toBe(handle);
      expect(enableOf(handle)).toBe(2);
      expect(handle.skill).toBe('skill of enable 2');
      expect(w.registry.stateOf('web')).toBe('enabled');
    });
  });

  it('R3 — a holder keeps what it took: the tools an agent spread before the save still answer, on their own entry, and nothing has been torn down', async () => {
    await run(function* () {
      const { spread, torn } = yield* reconfiguredUnderARun();
      expect(spread.map((t) => t.nth)).toEqual([1]);
      expect(yield* spread[0].execute({})).toEqual({ nth: 1 });
      expect(torn).toEqual([]);
    });
  });

  it('R4 — the superseded entry is torn down once, when the run that held it ends', async () => {
    await run(function* () {
      const { w, running, torn } = yield* reconfiguredUnderARun();
      yield* running.end();
      expect(torn).toEqual([1]);
      yield* running.end();
      expect(torn).toEqual([1]);
      // …and a second save, with no run holding anything, replaces at once.
      yield* w.dispatch({ type: 'set_ability_config', name: 'web', values: { tavilyKey: 'k2' } });
      expect(torn).toEqual([1, 2]);
      expect(enableOf(w.registry.byName('web')!)).toBe(3);
    });
  });

  it('R4, no run — a save replaces the entry at once', async () => {
    await run(function* () {
      const built: Enable[] = [];
      const torn: number[] = [];
      const web = numberedAbility({ name: 'web', built, torn });
      const w = yield* world({ abilities: [web], enable: ['web'] });
      const handle = w.registry.byName('web')!;
      yield* w.dispatch({ type: 'set_ability_config', name: 'web', values: { tavilyKey: 'k' } });
      expect(torn).toEqual([1]);
      expect(w.registry.byName('web')).toBe(handle);
      expect(enableOf(handle)).toBe(2);
    });
  });

  it('R4, two runs — an entry held by two runs ends when the second of them ends', async () => {
    await run(function* () {
      const built: Enable[] = [];
      const torn: number[] = [];
      const web = numberedAbility({ name: 'web', built, torn });
      const w = yield* world({ abilities: [web], enable: ['web'] });
      const first = yield* w.startRun();
      const second = yield* w.startRun();
      yield* w.dispatch({ type: 'set_ability_config', name: 'web', values: { tavilyKey: 'k' } });
      yield* first.end();
      expect(torn).toEqual([]);
      yield* second.end();
      expect(torn).toEqual([1]);
    });
  });
});
