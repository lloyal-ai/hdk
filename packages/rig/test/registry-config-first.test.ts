/**
 * The registry validates an ability's stored config against its manifest
 * BEFORE running its factory: a factory that reads a malformed config must not
 * be the thing that reports it, and must not have run at all.
 */
import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import { createAbilityRegistry } from '../src/registry';
import { createInMemoryConfigStore } from '../src/config-store';
import { fakeAbility } from './helpers/fake-ability';

describe('createAbilityRegistry: config before factory', () => {
  it('rejects a stored config the manifest refuses without running the factory', async () => {
    const seen: unknown[] = [];
    const corpus = fakeAbility({ name: 'corpus', configSchema: { type: 'object', required: ['corpusPath'], properties: { corpusPath: { type: 'string' } } }, saw: (c) => seen.push(c) });
    await expect(run(function* () {
      const store = createInMemoryConfigStore();
      yield* store.set('corpus', { wrong: true });
      const registry = yield* createAbilityRegistry({ configStore: store });
      yield* registry.enable(corpus);
    })).rejects.toThrow('missing required key "corpusPath"');
    expect(seen).toEqual([]);
  });
});
