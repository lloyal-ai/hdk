/**
 * Tests for the ability **Services** capability surface: the closed {@link SERVICES}
 * set, `AbilityManifest.services`, and the manifest an `AbilityFactory` carries
 * statically for the harness boot to read without running the factory.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import { SERVICES } from '../src/index';
import type { Ability, AbilityFactory, AbilityManifest, Service } from '../src/index';

describe('ability services', () => {
  it('SERVICES is the closed auxiliary set (trunk llm excluded)', () => {
    // `vision` joined so that ONE rule covers every auxiliary model: it is
    // fetched because a consumer declared the capability. It used to ride the
    // model's catalog pairing instead, so a harness that could not send an image
    // still fetched a 672 MB projector for one.
    expect(SERVICES).toEqual(['reranker', 'embedding', 'vision']);
    // The trunk model is never a service: it is the harness's own, always
    // present, and nothing declares it.
    expect(SERVICES).not.toContain('llm');
  });

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

  it('AbilityManifest.services typechecks as the closed Service set', () => {
    const svcs: readonly Service[] = ['reranker'];
    const m: AbilityManifest = {
      name: 'demo',
      protocol: { name: 'demo_research', useWhen: 'demoing', tools: ['demo_tool'] },
      services: svcs,
    };
    expect(m.services).toEqual(['reranker']);
  });
});
