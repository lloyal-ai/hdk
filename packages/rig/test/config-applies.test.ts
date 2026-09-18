/**
 * `applies` says when a change to a key takes effect, for whatever offers one. rig freezes the whole `model`
 * family in a running session — a save cannot change the residency — so a model key that claimed to apply to
 * the `session` would be offered a control that silently does nothing.
 */
import { describe, it, expect } from 'vitest';
import { modelSettings } from '../src/config';
import type { ConfigKey } from '../src/config';

describe('config keys: when a change applies', () => {
  it('every key of the model block says so, and none claims the running session', () => {
    for (const [key, decl] of Object.entries(modelSettings) as [string, ConfigKey][]) {
      expect(decl.applies, key).toBeDefined();
      expect(decl.applies, key).not.toBe('session');
    }
  });
  it('what the process already built or loaded is boot: the context it sized, the backend it picked; what names the residency is reload', () => {
    const tier = (k: keyof typeof modelSettings) => (modelSettings[k] as ConfigKey).applies;
    expect([tier('model.nCtx'), tier('model.branches'), tier('model.kvCache'), tier('model.gpu')]).toEqual(['boot', 'boot', 'boot', 'boot']);
    expect([tier('model.path'), tier('model.id'), tier('model.reranker')]).toEqual(['reload', 'reload', 'reload']);
  });
});
