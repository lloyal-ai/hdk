/**
 * What `createReranker` asks for — the KV type it requests, and the options it
 * forwards.
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
const { rerankCreate } = vi.hoisted(() => ({
  rerankCreate: vi.fn(async () => ({
    score: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
    scoreBatch: async () => [],
    tokenize: async () => [],
    dispose: () => {},
  })),
}));

vi.mock('@lloyal-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lloyal-labs/sdk')>();
  return { ...actual, Rerank: { create: rerankCreate } };
});

const { createReranker } = await import('../src/reranker');

describe('createReranker — KV precision', () => {
  beforeEach(() => {
    createContext.mockClear();
    rerankCreate.mockClear();
  });

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

describe('createReranker — option forwarding', () => {
  beforeEach(() => {
    createContext.mockClear();
    rerankCreate.mockClear();
  });

  const load = (opts?: Record<string, unknown>) =>
    run(function* () {
      yield* createReranker('/fake/reranker.gguf', opts);
    });

  it('forwards a custom instruction to Rerank.create', async () => {
    // Dropping `instruction: opts?.instruction` from the adapter would pass every
    // other test in the repo — the SDK suite calls `Rerank.create` directly and
    // never exercises this hop — and every harness would silently run retrieval.
    // That is the dropped-option failure this whole PR exists to prevent.
    const instruction = {
      text: 'Judge whether the statement is entailed by the evidence',
      smokeTest: 'none' as const,
    };
    await load({ instruction });
    expect(rerankCreate).toHaveBeenCalledTimes(1);
    const opts = rerankCreate.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.instruction).toEqual(instruction);
  });

  it('passes instruction through as undefined when none is given', async () => {
    // `Rerank.create` owns the default. The adapter must not substitute one of
    // its own, or the two layers can disagree about what "default" means.
    await load();
    const opts = rerankCreate.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.instruction).toBeUndefined();
  });

  it('forwards the sizing options it resolves', async () => {
    await load({ nSeqMax: 6, nCtx: 2048 });
    const opts = rerankCreate.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.nSeqMax).toBe(6);
    expect(opts.nCtx).toBe(2048);
  });
});
