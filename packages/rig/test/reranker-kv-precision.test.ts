/**
 * The reranker's KV cache must DEFAULT to f16.
 *
 * WHAT THIS TEST IS: a guard on the DEFAULT. It mocks the native context so it
 * can assert which KV type `createReranker` asks for when nobody says, and it
 * will fail if someone reinstates a quantised default. An explicit override is
 * honoured — this guards the default, not the knob.
 *
 * WHAT IT IS NOT: evidence that scores are precise. The property that actually
 * matters — six leaves forked from one parent, given identical tokens, scoring
 * identically — needs a real model and cannot run here. That measurement lives
 * in `test/evals/reranker/isolation.eval.ts`, and its results are recorded in
 * the comment this test protects. A green test here with a quantised cache
 * underneath would be exactly the kind of check that passes while the thing it
 * claims to protect is broken, so the distinction is stated rather than implied.
 *
 * @category Testing
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { run } from 'effection';

const { createContext, fakeCtx } = vi.hoisted(() => {
  const fakeCtx = {
    _storeKvPressure: () => ({ nCtx: 4096, cellsUsed: 0, remaining: 4096 }),
    tokenize: async () => [1],
    dispose: () => {},
  };
  return { fakeCtx, createContext: vi.fn(async () => fakeCtx) };
});

// The native binding and Rerank's boot gates both need a real model; neither is
// the unit under test. What is under test is the context REQUEST.
vi.mock('@lloyal-labs/lloyal.node', () => ({ createContext }));
vi.mock('@lloyal-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lloyal-labs/sdk')>();
  return {
    ...actual,
    Rerank: {
      create: vi.fn(async () => ({
        score: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
        scoreBatch: async () => [],
        tokenize: async () => [],
        dispose: () => {},
      })),
    },
  };
});

const { createReranker } = await import('../src/reranker');

describe('reranker KV precision', () => {
  beforeEach(() => createContext.mockClear());

  const load = (opts?: Record<string, unknown>) =>
    run(function* () {
      // The resource yields inside its own scope; entering and leaving is
      // enough to observe the context request.
      yield* createReranker('/fake/reranker.gguf', opts);
    });

  it('requests an f16 KV cache, not a quantised one', async () => {
    await load();
    expect(createContext).toHaveBeenCalledTimes(1);
    const args = createContext.mock.calls[0][0] as Record<string, unknown>;
    expect(args.typeK).toBe('f16');
    expect(args.typeV).toBe('f16');
  });

  it('honours an explicit override, because memory pressure is real', async () => {
    // f16 is a DEFAULT, not a lock. A harness on a constrained machine can drop
    // it — the docblock states what that costs. Refusing the override would be
    // protecting cross-harness score comparability, which does not exist: the
    // reranker is a relative ranker, and nCtx/nSeqMax already move scores by
    // changing per-leaf truncation.
    await load({ typeK: 'q8_0', typeV: 'q8_0' });
    const args = createContext.mock.calls[0][0] as Record<string, unknown>;
    expect(args.typeK).toBe('q8_0');
    expect(args.typeV).toBe('q8_0');
  });

  it('still honours the sizing options', async () => {
    await load({ nSeqMax: 6, nCtx: 2048 });
    const args = createContext.mock.calls[0][0] as Record<string, unknown>;
    expect(args.nSeqMax).toBe(6);
    expect(args.nCtx).toBe(2048);
    // nBatch derives from the two above when not given.
    expect(args.nBatch).toBe(Math.floor(2048 / 6));
  });
});
