/**
 * Tests for the app **Services** capability surface: the closed {@link SERVICES}
 * set, `AppManifest.services`, and the manifest an `AppFactory` carries
 * statically for the harness boot to read without running the factory.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import { SERVICES } from '../src/index';
import type { App, AppFactory, AppManifest, Service } from '../src/index';

describe('app services', () => {
  it('SERVICES is the closed reranker+embedding set (trunk llm excluded)', () => {
    expect(SERVICES).toEqual(['reranker', 'embedding']);
    expect(SERVICES).not.toContain('llm');
  });

  it('a factory carries its manifest statically — services readable without running it', () => {
    const manifest: AppManifest = {
      name: 'demo',
      protocol: { name: 'demo_research', useWhen: 'demoing', tools: ['demo_tool'] },
      services: ['reranker'],
    };
    const f = function* (): Generator<never, App, unknown> {
      throw new Error('not run');
    };
    const factory: AppFactory = Object.assign(f as unknown as AppFactory, { manifest });
    expect(factory.manifest?.services).toEqual(['reranker']);
  });

  it('a factory with no manifest reads as undefined', () => {
    const factory: AppFactory = function* (): Generator<never, App, unknown> {
      throw new Error('not run');
    } as unknown as AppFactory;
    expect(factory.manifest).toBeUndefined();
  });

  it('AppManifest.services typechecks as the closed Service set', () => {
    const svcs: readonly Service[] = ['reranker'];
    const m: AppManifest = {
      name: 'demo',
      protocol: { name: 'demo_research', useWhen: 'demoing', tools: ['demo_tool'] },
      services: svcs,
    };
    expect(m.services).toEqual(['reranker']);
  });
});
