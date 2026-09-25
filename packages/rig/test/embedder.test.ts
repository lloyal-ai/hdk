/**
 * The embedder's discipline over one context, proven against a fake native context that records every call:
 * a queue that spans callers, a refusal that touches nothing, a teardown that waits for in-flight work, and
 * the pooling the model needs reaching the context.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { call, run, scoped, sleep, spawn } from 'effection';

const { createContext, fakeCtx, log, gate } = vi.hoisted(() => {
  const log: string[] = [];
  // Every encode parks on this until the test opens it — how a test holds native work "in flight".
  const gate = { open: Promise.resolve(), release: () => {} };
  const fakeCtx = {
    tokenize: async (text: string, addSpecial?: boolean) => { log.push(`tokenize:${text}${addSpecial ? '+special' : ''}`); return Array.from({ length: text.length }, (_, i) => i); },
    kvCacheClear: async () => { log.push('clear'); },
    encode: async (tokens: number[]) => { await gate.open; log.push(`encode:${tokens.length}`); },
    getEmbeddings: (_normalize?: boolean) => { log.push('get'); return new Float32Array([log.length, 0.5]); },
    getEmbeddingDimension: () => 2,
    dispose: () => { log.push('dispose'); },
  };
  return { log, gate, fakeCtx, createContext: vi.fn(async (_opts: Record<string, unknown>) => fakeCtx) };
});
vi.mock('@lloyal-labs/lloyal.node', () => ({ createContext }));

const { createEmbedder } = await import('../src/providers/embedding');

beforeEach(() => {
  log.length = 0;
  createContext.mockClear();
  gate.open = Promise.resolve();
});

describe('createEmbedder — the context it asks for', () => {
  it('a dedicated embedding context: one sequence, batch = context, the pooling the model needs', async () => {
    await run(function* () {
      yield* createEmbedder('/e.gguf', { nCtx: 512, pooling: 'last' });
    });
    const opts = (createContext.mock.calls as unknown as [Record<string, unknown>][])[0][0];
    expect(opts).toMatchObject({ modelPath: '/e.gguf', nCtx: 512, nBatch: 512, nSeqMax: 1, embeddings: true });
    expect(opts.poolingType).toBe(3); // PoolingType.LAST — the model's own property, never the runtime's default
  });

  it('tokenizes with the model\'s own special tokens — what last-token pooling reads', async () => {
    await run(function* () {
      const e = yield* createEmbedder('/e.gguf', { pooling: 'last' });
      yield* e.tokenize('x');
      yield* e.embed(['y']);
    });
    expect(log.filter((l) => l.startsWith('tokenize'))).toEqual(['tokenize:x+special', 'tokenize:y+special']);
  });

  it('reports the model\'s dimension', async () => {
    const dim = await run(function* () {
      const e = yield* createEmbedder('/e.gguf', { pooling: 'mean' });
      return e.dimension;
    });
    expect(dim).toBe(2);
  });
});

describe('embed — one text at a time, one caller at a time', () => {
  it('per text: clear, encode, read — never interleaved across concurrent callers', async () => {
    await run(function* () {
      const e = yield* createEmbedder('/e.gguf', { pooling: 'mean' });
      const [a, b] = yield* scoped(function* () {
        const ta = yield* spawn(() => e.embed(['aa', 'bbb']));
        const tb = yield* spawn(() => e.embed(['cccc']));
        return [yield* ta, yield* tb];
      });
      expect(a).toHaveLength(2);
      expect(b).toHaveLength(1);
    });
    // The second caller's work starts only after the first caller's last read.
    const ops = log.filter((l) => !l.startsWith('tokenize'));
    expect(ops).toEqual(['clear', 'encode:2', 'get', 'clear', 'encode:3', 'get', 'clear', 'encode:4', 'get', 'dispose']);
  });

  it('a text longer than the context is refused before the context is touched, and the next call is unaffected', async () => {
    await run(function* () {
      const e = yield* createEmbedder('/e.gguf', { nCtx: 3, pooling: 'mean' });
      let refused: unknown;
      try { yield* e.embed(['ok', 'far too long']); } catch (err) { refused = err; }
      expect(String(refused)).toMatch(/text 1 is 12 tokens; `model\.embedding\.context` is 3/);
      expect(log.filter((l) => !l.startsWith('tokenize'))).toEqual([]);
      const out = yield* e.embed(['ok']);
      expect(out).toHaveLength(1);
    });
    expect(log.filter((l) => !l.startsWith('tokenize'))).toEqual(['clear', 'encode:2', 'get', 'dispose']);
  });

  it('answers a copy: a caller mutating its vector changes nothing the next read sees', async () => {
    await run(function* () {
      const e = yield* createEmbedder('/e.gguf', { pooling: 'mean' });
      const [v] = yield* e.embed(['a']);
      v[1] = 99;
      const [w] = yield* e.embed(['a']);
      expect(w[1]).toBe(0.5);
    });
  });
});

describe('teardown', () => {
  it('leaving the scope stops new work at once and frees the context only after the encode in flight settles', async () => {
    let release!: () => void;
    gate.open = new Promise<void>((resolve) => { release = resolve; });
    let later: Float32Array[] | undefined;
    let afterScope: string[] = [];
    const done = run(function* () {
      yield* scoped(function* () {
        const e = yield* createEmbedder('/e.gguf', { pooling: 'mean' });
        const parked = yield* spawn(() => e.embed(['a']));   // parks on the gate inside encode
        yield* sleep(0);
        // Leave the scope while the encode is in flight: the task is halted with it.
        void parked;
      });
      afterScope = [...log];
    });
    // Teardown is waiting on the gate: nothing disposed yet.
    await new Promise((r) => setTimeout(r, 20));
    expect(log).not.toContain('dispose');
    release();
    await done;
    void later;
    expect(afterScope.at(-1)).toBe('dispose');
    expect(afterScope.indexOf('encode:1')).toBeLessThan(afterScope.indexOf('dispose'));
  });

  it('after dispose, embed refuses rather than queueing onto a freed context', async () => {
    await run(function* () {
      const e = yield* createEmbedder('/e.gguf', { pooling: 'mean' });
      e.dispose();
      let refused: unknown;
      try { yield* e.embed(['a']); } catch (err) { refused = err; }
      expect(String(refused)).toMatch(/disposed/);
    });
  });
});
