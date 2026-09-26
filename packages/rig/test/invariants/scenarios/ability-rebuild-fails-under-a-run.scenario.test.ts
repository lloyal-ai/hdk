/**
 * R5: a rebuild that fails under a run changes nothing. The factory refuses the new configuration; the
 * current entry keeps serving through the same handle, the stored config is what it was, no scope is
 * torn down — not when the run ends either — and the reader is told why.
 */
import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import { world, numberedAbility } from '../harness';
import type { Enable, EnableTool } from '../harness';

describe('an ability whose rebuild fails under a run', () => {
  it('R5 — the current entry keeps serving, the stored config is restored, nothing is torn down, and the refusal is said', async () => {
    await run(function* () {
      const built: Enable[] = [];
      const torn: number[] = [];
      const web = numberedAbility({
        name: 'web', built, torn,
        refuse: (config) => (config?.tavilyKey === 'bad' ? 'that key is not accepted' : undefined),
      });
      const w = yield* world({ abilities: [web], enable: ['web'], config: { web: { tavilyKey: 'good' } } });
      const running = yield* w.startRun();
      const handle = running.sources[0];
      const spread = [...handle.tools] as EnableTool[];

      yield* w.dispatch({ type: 'set_ability_config', name: 'web', values: { tavilyKey: 'bad' } });

      expect(w.sent.some((e) => e.type === 'ui:error' && /Cannot configure web: that key is not accepted/.test((e as { message: string }).message))).toBe(true);
      expect(yield* w.store.get('web')).toEqual({ tavilyKey: 'good' });
      expect(w.registry.byName('web')).toBe(handle);
      expect(w.registry.stateOf('web')).toBe('enabled');
      expect(yield* handle.tools[0].execute({})).toEqual({ nth: 1 });   // through the tool object, as an agent would ask
      expect(yield* spread[0].execute({})).toEqual({ nth: 1 });
      expect(torn).toEqual([]);
      expect(built.map((b) => b.nth)).toEqual([1]);   // the refused enable never became an entry
      yield* running.end();
      expect(torn).toEqual([]);   // still the current entry: the run's end releases a hold, not the roster
    });
  });
});
