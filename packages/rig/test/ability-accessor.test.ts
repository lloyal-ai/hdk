/** `ability(name)` — the registry accessor: the enabled ability, or a refusal that names it. */
import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import { AbilityRegistryCtx } from '@lloyal-labs/lloyal-agents';
import type { Ability, AbilityRegistry } from '@lloyal-labs/lloyal-agents';
import { ability } from '../src/registry';

const web = { manifest: { name: 'web' } } as unknown as Ability;
const registry = {
  byName: (name: string) => (name === 'web' ? web : undefined),
  enabled: () => [web],
  stateOf: (name: string) => (name === 'web' ? 'enabled' : 'disabled'),
  *enable() { return web; },
  *disable() {},
} as unknown as AbilityRegistry;

describe('ability(name)', () => {
  it('returns the enabled ability', async () => {
    const got = await run(function* () {
      yield* AbilityRegistryCtx.set(registry);
      return yield* ability('web');
    });
    expect(got).toBe(web);
  });

  it('refuses an ability that is not enabled, naming it', async () => {
    let caught: unknown = null;
    await run(function* () {
      yield* AbilityRegistryCtx.set(registry);
      try { yield* ability('corpus'); } catch (e) { caught = e; }
    });
    expect((caught as Error).message).toMatch(/corpus/);
  });
});
