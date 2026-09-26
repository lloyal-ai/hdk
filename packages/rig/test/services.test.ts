/**
 * The service contract's consumer side: the closed {@link ServiceMap}, its runtime list
 * {@link SERVICES}, the one accessor {@link service} and its refusal, and the manifest an
 * `AbilityFactory` carries statically for the harness boot to read without running it.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import { SERVICES, Services, service } from '../src/index';
import type { Ability, AbilityFactory, AbilityManifest, Reranker, ServiceMap } from '../src/index';

describe('the closed service set', () => {
  it('SERVICES lists every key of ServiceMap, and nothing else — the trunk llm is never a service', () => {
    expect(SERVICES).toEqual(['reranker', 'vision', 'embedding']);
    expect(SERVICES).not.toContain('llm');
    // Exhaustive in both directions: a key of the map without a name, or a name without a key, is a build error.
    const every: { [K in keyof ServiceMap]: true } = { reranker: true, vision: true, embedding: true };
    expect(Object.keys(every).sort()).toEqual([...SERVICES].sort());
  });
});

describe('service(name) — the one way a harness or an ability reaches a service', () => {
  const bound = { id: 'the bound reranker' } as unknown as Reranker;

  it('answers the bound instance', async () => {
    const got = await run(function* () {
      yield* Services.set({ reranker: bound });
      return yield* service('reranker');
    });
    expect(got).toBe(bound);
  });

  it('refuses by name when nothing bound it, naming the block that would', async () => {
    await expect(run(function* () { return yield* service('reranker'); })).rejects.toThrow(
      '`reranker` is not configured — add `model.reranker` to harness.yml',
    );
  });

  it('is availability, not permission: any scope under the binding reads it', async () => {
    const got = await run(function* () {
      yield* Services.set({ reranker: bound });
      return yield* (function* () { return yield* service('reranker'); })();
    });
    expect(got).toBe(bound);
  });
});

describe('the manifest', () => {
  it('a factory carries its manifest statically — services readable without running it', () => {
    const manifest: AbilityManifest = {
      name: 'demo',
      protocol: { name: 'demo_research', useWhen: 'demoing', tools: ['demo_tool'] },
      services: ['reranker'],
    };
    const f = function* (): Generator<never, Ability, unknown> {
      throw new Error('not run');
    };
    const factory: AbilityFactory = Object.assign(f as unknown as AbilityFactory, { manifest });
    expect(factory.manifest?.services).toEqual(['reranker']);
  });

  it('a factory with no manifest reads as undefined', () => {
    const factory: AbilityFactory = function* (): Generator<never, Ability, unknown> {
      throw new Error('not run');
    } as unknown as AbilityFactory;
    expect(factory.manifest).toBeUndefined();
  });

  it('services is parsed JSON — names, checked against SERVICES where the manifest is defined, not by the type', () => {
    const m: AbilityManifest = {
      name: 'demo',
      protocol: { name: 'demo_research', useWhen: 'demoing', tools: ['demo_tool'] },
      services: ['reranker', 'something-newer'],
    };
    expect(m.services).toEqual(['reranker', 'something-newer']);
  });
});
