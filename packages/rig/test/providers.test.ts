/**
 * The provider table: one row per name in the closed set, each written from the contract alone.
 */
import { describe, it, expect } from 'vitest';
import { SERVICES } from '../src/services';
import { providers } from '../src/providers';
import { modelSettings } from '../src/config';
import type { ConfigKey } from '../src/config';

describe('the provider table', () => {
  it('has a row for every service, and every row binds or joins the trunk — never both, never neither', () => {
    expect(Object.keys(providers).sort()).toEqual([...SERVICES].sort());
    for (const name of SERVICES) {
      const row = providers[name] as { bind?: unknown; trunk?: unknown };
      expect([typeof row.bind, typeof row.trunk].filter((t) => t === 'function'), name).toHaveLength(1);
    }
  });

  it('the vision row derives the projector the catalog pairs with the llm, and nothing under a path: llm or an unpaired id', () => {
    const { derive, trunk } = providers.vision;
    expect(derive!({ llm: { id: 'qwen3.5-4b' } })).toEqual({ id: 'qwen3.5-4b-mmproj' });
    expect(derive!({ llm: { path: '/m.gguf' } })).toBeUndefined();
    expect(derive!({ llm: { id: 'not-in-the-catalog' } })).toBeUndefined();
    expect(derive!({ llm: {} })).toBeUndefined();
    expect(trunk!('/models/vision/p.gguf', { minTokens: 64, maxTokens: 512 })).toEqual({ mmprojPath: '/models/vision/p.gguf', imageMinTokens: 64, imageMaxTokens: 512 });
  });

  it('every row names what it acquires, in a reader\'s words — the install\'s step label is made of it', () => {
    expect(Object.fromEntries(Object.entries(providers).map(([k, row]) => [k, row.name]))).toEqual({
      reranker: 'reranker', vision: 'vision projector', embedding: 'embedding model',
    });
  });

  it('the embedding row binds, and reads its pooling from the block, else the catalog, else refuses — at plan time through `refuse`, and again at bind', () => {
    const row = providers.embedding as unknown as { bind: (artifact: string, block: Record<string, unknown>) => unknown; refuse: (block: Record<string, unknown>) => string | undefined };
    expect(typeof row.bind).toBe('function');
    expect(row.refuse({ path: '/e.gguf', context: 2048 })).toMatch(/`model\.embedding\.pooling`/);
    expect(row.refuse({ id: 'not-in-the-catalog', context: 2048 })).toMatch(/`model\.embedding\.pooling`/);
    expect(row.refuse({ path: '/e.gguf', pooling: 'last' })).toBeUndefined();
    expect(row.refuse({ id: 'nomic-embed-text-v1.5-q4' })).toBeUndefined();
    // The binding itself is mocked in embedder.test.ts; here the last-line refusal, for a block handed to bind directly.
    expect(() => row.bind('/e.gguf', { path: '/e.gguf', context: 2048 })).toThrow(/`model\.embedding\.pooling`/);
  });

  it('every service has its block in the model family: an id and a path to select by', () => {
    for (const name of SERVICES) {
      expect(modelSettings[`model.${name}.id` as keyof typeof modelSettings], name).toBeDefined();
      expect(modelSettings[`model.${name}.path` as keyof typeof modelSettings], name).toBeDefined();
    }
  });
});

describe('the reranker block\'s instruction', () => {
  const check = (modelSettings['model.reranker.instruction'] as ConfigKey).check!;
  it('is the scoring question with its canary, or the question alone', () => {
    expect(check({ text: 'Is it relevant?', smokeTest: 'none' })).toBe(true);
    expect(check({ text: 'Is it relevant?', smokeTest: { query: 'q', matching: 'yes', nonMatching: 'no', minGap: 1 } })).toBe(true);
  });
  it('refuses what the reranker would refuse at load: no text, a canary with a missing side, a negative or infinite gap', () => {
    expect(check({ smokeTest: 'none' })).toBe(false);
    expect(check('Is it relevant?')).toBe(false);
    expect(check({ text: 'q', smokeTest: { query: 'q', matching: 'yes', minGap: 1 } })).toBe(false);
    expect(check({ text: 'q', smokeTest: { query: 'q', matching: 'yes', nonMatching: 'no', minGap: -1 } })).toBe(false);
    expect(check({ text: 'q', smokeTest: { query: 'q', matching: 'yes', nonMatching: 'no', minGap: Infinity } })).toBe(false);
  });
});
