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
  it('every key of the model block says what it is, in a sentence that names neither the tier nor the file', () => {
    for (const [key, decl] of Object.entries(modelSettings) as [string, ConfigKey][]) {
      expect(decl.describe, key).toMatch(/\S.*\.$/);
      expect(decl.describe, key).not.toMatch(/harness\.yml|restart|next run/i);
    }
  });
  it('what the process already built or loaded is boot: the context it sized, the backend it picked; what names the residency is reload', () => {
    const tier = (k: keyof typeof modelSettings) => (modelSettings[k] as ConfigKey).applies;
    expect([tier('model.llm.context'), tier('model.llm.branches'), tier('model.llm.kvCache'), tier('model.llm.gpu'), tier('model.reranker.context')]).toEqual(['boot', 'boot', 'boot', 'boot', 'boot']);
    expect([tier('model.llm.path'), tier('model.llm.id'), tier('model.reranker.path'), tier('model.reranker.id'), tier('model.vision.id')]).toEqual(['reload', 'reload', 'reload', 'reload', 'reload']);
  });
  it('every key lives at its yml path: one block per model, the key named as harness.yml names it', () => {
    for (const [key, decl] of Object.entries(modelSettings) as [string, ConfigKey][]) {
      expect(decl.yml, key).toBe(key);
      expect(key.split('.'), key).toHaveLength(3);
    }
    expect(Object.keys(modelSettings).filter((k) => k.endsWith('.id')).sort()).toEqual(['model.embedding.id', 'model.llm.id', 'model.reranker.id', 'model.vision.id']);
  });
});
