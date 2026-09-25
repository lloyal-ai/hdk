/**
 * R1–R4: an ability reconfigured while a run is live.
 *
 * A save applies at once (R1): the new entry is registered and the name resolves to it (R2); an agent that
 * spread the ability's tools before the save keeps working on the entry it took, and so does one that spread
 * them after — a scope holds the NAMES it took, so every entry enabled under them while it lives outlives it
 * (R3); the superseded entry's scope ends when the last run holding its name ends, once — and at once when no
 * run holds it (R4). A value a tool reads at the call — its ability's stored config — follows the store, not
 * the entry; that is the ability's side, held in its own tests. Nobody asks whether a run is live.
 */
import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import type { Operation } from 'effection';
import { world, numberedAbility } from '../harness';
import type { Enable, EnableTool } from '../harness';

/** Which enable answers the ability's first tool now — through the tool object, as an agent would ask. */
function* enableOf(ability: { tools: readonly { execute(args: unknown): Operation<unknown> }[] }): Operation<number> {
  return ((yield* ability.tools[0].execute({})) as { nth: number }).nth;
}

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
      expect(yield* enableOf(handle)).toBe(2);
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

  it('R3, two saves — an entry the run took through its handle AFTER the first save is held too: a second save supersedes it without ending it', async () => {
    await run(function* () {
      const { w, running, handle, torn } = yield* reconfiguredUnderARun();
      const spreadLater = [...handle.tools] as EnableTool[];   // a later spawn's tools: entry 2's
      expect(spreadLater.map((t) => t.nth)).toEqual([2]);
      yield* w.dispatch({ type: 'set_ability_config', name: 'web', values: { tavilyKey: 'k2' } });
      expect(torn).toEqual([]);
      expect(yield* spreadLater[0].execute({})).toEqual({ nth: 2 });
      expect(yield* enableOf(handle)).toBe(3);
      yield* running.end();
      expect(torn).toEqual([1, 2]);
      expect(yield* enableOf(w.registry.byName('web')!)).toBe(3);
    });
  });

  it('R3, disabled — an entry the run took after a save is held through a disable as well: it ends when the run does', async () => {
    await run(function* () {
      const { w, running, handle, torn } = yield* reconfiguredUnderARun();
      const spreadLater = [...handle.tools] as EnableTool[];
      yield* w.registry.disable('web');
      expect(w.registry.stateOf('web')).toBe('disabled');
      expect(torn).toEqual([]);
      expect(yield* spreadLater[0].execute({})).toEqual({ nth: 2 });
      yield* running.end();
      expect(torn).toEqual([1, 2]);
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
      expect(yield* enableOf(w.registry.byName('web')!)).toBe(3);
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
      expect(yield* enableOf(handle)).toBe(2);
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
