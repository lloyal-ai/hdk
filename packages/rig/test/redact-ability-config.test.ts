/** `redactAbilityConfig` — ability config never rides a wire; only key presence does. */
import { describe, it, expect } from 'vitest';
import { redactAbilityConfig } from '../src/ability-descriptors';
import { CONFIG_VERSION } from '../src/config';

describe('redactAbilityConfig', () => {
  it('replaces every ability config value with key presence, leaves the rest, mutates nothing', () => {
    const config = {
      version: CONFIG_VERSION,
      sources: { outputDir: '/reports' },
      abilities: { web: { tavilyKey: 'secret', topN: 5 }, corpus: {} },
      model: { llm: { path: '/m.gguf' } },
    };
    const redacted = redactAbilityConfig(config);
    expect(redacted.abilities).toEqual({ web: { tavilyKey: true, topN: true }, corpus: {} });
    expect(redacted.sources).toEqual({ outputDir: '/reports' });
    expect(redacted.model).toEqual({ llm: { path: '/m.gguf' } });
    expect(config.abilities.web.tavilyKey).toBe('secret');
  });
});
