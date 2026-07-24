/**
 * Tests for the app model-role capability surface: the closed
 * {@link APP_MODEL_ROLES} set, `AppManifest.requires`, and the static
 * `AppFactory.requires` the harness boot reads without running the factory.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import { APP_MODEL_ROLES } from '../src/index';
import type { App, AppFactory, AppManifest, AppModelRole } from '../src/index';

describe('app model roles', () => {
  it('APP_MODEL_ROLES is the closed reranker+embedding set (trunk llm excluded)', () => {
    expect(APP_MODEL_ROLES).toEqual(['reranker', 'embedding']);
    expect(APP_MODEL_ROLES).not.toContain('llm');
  });

  it('a factory carries requires statically — readable without running it', () => {
    const requires: readonly AppModelRole[] = ['reranker'];
    const f = function* (): Generator<never, App, unknown> {
      throw new Error('not run');
    };
    const factory: AppFactory = Object.assign(f as unknown as AppFactory, { requires });
    expect(factory.requires).toEqual(['reranker']);
  });

  it('a factory with no requires reads as undefined', () => {
    const factory: AppFactory = function* (): Generator<never, App, unknown> {
      throw new Error('not run');
    } as unknown as AppFactory;
    expect(factory.requires).toBeUndefined();
  });

  it('AppManifest.requires typechecks as the closed set', () => {
    const m: AppManifest = {
      name: 'demo',
      protocol: { name: 'demo_research', useWhen: 'demoing', tools: ['demo_tool'] },
      requires: ['reranker'],
    };
    expect(m.requires).toEqual(['reranker']);
  });
});
