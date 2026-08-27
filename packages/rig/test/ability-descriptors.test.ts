/**
 * The ONE descriptor builder every harness emits `abilities:state` from:
 * enabled abilities from the registry, installed-but-not-enabled off the
 * factory's static manifest, and config structurally redacted to
 * key-presence — values never leave the builder.
 */
import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import { buildAbilityDescriptors } from '../src/ability-descriptors';

const manifest = (name: string, tools: string[], schema?: unknown) => ({
  name,
  protocol: { name: `${name}_protocol`, useWhen: `use ${name}`, tools },
  configSchema: schema,
});

describe('buildAbilityDescriptors', () => {
  it('enabled from the registry, installed off the factory manifest, redacted', async () => {
    const store = new Map<string, Record<string, unknown>>([
      ['web', { tavilyKey: 'SECRET-VALUE' }],
      ['corpus', { corpusPath: '/docs' }],
    ]);
    const registry = {
      enabled: () => [{ manifest: manifest('web', ['web_search'], { type: 'object' }) }],
    };
    const configStore = { *get(name: string) { return store.get(name); } };
    const factories = [
      Object.assign(function* () {}, { manifest: manifest('web', ['web_search']) }),
      Object.assign(function* () {}, { manifest: manifest('corpus', ['corpus_search']) }),
    ];

    const out = await run(() =>
      buildAbilityDescriptors(registry as never, configStore as never, factories as never));

    expect(out.map((d) => [d.name, d.enabled])).toEqual([['web', true], ['corpus', false]]);
    // redaction is structural: key-presence only, never the value
    expect(out[0].config).toEqual({ tavilyKey: true });
    expect(out[1].config).toEqual({ corpusPath: true });
    expect(JSON.stringify(out)).not.toContain('SECRET-VALUE');
    expect(out[1].tools).toEqual(['corpus_search']);
  });
});
