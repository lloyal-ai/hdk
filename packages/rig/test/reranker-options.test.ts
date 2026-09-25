/**
 * What `createReranker` asks for — the KV type it requests, and the options it
 * forwards.
 *
 * WHAT THIS TEST IS: a guard on the DEFAULT and on what gets forwarded. It
 * mocks the native context so it can assert which KV type `createReranker`
 * asks for when nobody says, and that the options a caller supplies survive
 * the hop into `Rerank.create`.
 *
 * The KV type asserted here is the one this version requests when the caller
 * says nothing. KV precision bounds the smallest meaningful score difference,
 * so which type gets requested is behaviour, not configuration trivia.
 *
 * @category Testing
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { run, sleep, spawn } from 'effection';

const { createContext, fakeCtx } = vi.hoisted(() => {
  const fakeCtx = {
    _storeKvPressure: () => ({ nCtx: 4096, cellsUsed: 0, remaining: 4096 }),
    tokenize: async () => [1],
    dispose: vi.fn(),
  };
  // Declare the parameter: `vi.fn(async () => …)` types `mock.calls` as an
  // EMPTY tuple, so `calls[0][0]` is a type error and every read needs a cast
  // through `undefined`. Naming the argument is what makes the assertions below
  // check a real shape instead of an `unknown`.
  return {
    fakeCtx,
    createContext: vi.fn(async (_opts: Record<string, unknown>) => fakeCtx),
  };
});

// The native binding and Rerank's boot gates both need a real model; neither is
// the unit under test. What is under test is the context REQUEST.
vi.mock('@lloyal-labs/lloyal.node', () => ({ createContext }));
const { rerankCreate, rerankDispose } = vi.hoisted(() => ({
  rerankDispose: vi.fn(),
  rerankCreate: vi.fn(),
}));

rerankCreate.mockImplementation(async () => ({
  score: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
  scoreBatch: async () => [],
  tokenize: async () => [],
  dispose: rerankDispose,
}));

vi.mock('@lloyal-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lloyal-labs/sdk')>();
  return { ...actual, Rerank: { create: rerankCreate } };
});

const { createReranker } = await import('../src/providers/reranker');

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

  it('requests q8_0 for both KV types when the caller specifies neither — the resolution the verdicts need', async () => {
    await load();
    expect(createContext).toHaveBeenCalledTimes(1);
    const args = createContext.mock.calls[0][0];
    expect(args.typeK).toBe('q8_0');
    expect(args.typeV).toBe('q8_0');
  });

  it('requests the caller\'s KV types when given', async () => {
    await load({ typeK: 'f16', typeV: 'f16' });
    const args = createContext.mock.calls[0][0];
    expect(args.typeK).toBe('f16');
    expect(args.typeV).toBe('f16');
  });

  it('still honours the sizing options', async () => {
    await load({ nSeqMax: 6, nCtx: 2048 });
    const args = createContext.mock.calls[0][0];
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

describe('createReranker — ownership begins with the request', () => {
  beforeEach(() => {
    createContext.mockClear();
    rerankCreate.mockClear();
    rerankDispose.mockClear();
    fakeCtx.dispose.mockClear();
  });

  it('a rejected boot canary frees the context exactly once, and the rejection is the caller\'s', async () => {
    rerankCreate.mockRejectedValueOnce(new Error('smoke test failed'));
    await expect(
      run(function* () {
        yield* createReranker('/fake/reranker.gguf');
      }),
    ).rejects.toThrow('smoke test failed');
    expect(fakeCtx.dispose).toHaveBeenCalledTimes(1);
    expect(rerankDispose).not.toHaveBeenCalled();
  });

  it('on a successful boot the context lives for the scope: not freed inside it, freed once when it ends', async () => {
    await run(function* () {
      yield* createReranker('/fake/reranker.gguf');
      expect(fakeCtx.dispose).not.toHaveBeenCalled();
    });
    expect(fakeCtx.dispose).toHaveBeenCalledTimes(1);
  });

  it('teardown frees the composition, then the context — each owner frees what it requested', async () => {
    const order: string[] = [];
    rerankDispose.mockImplementation(() => { order.push('rerank'); });
    fakeCtx.dispose.mockImplementation(() => { order.push('ctx'); });
    await run(function* () {
      yield* createReranker('/fake/reranker.gguf');
    });
    expect(order).toEqual(['rerank', 'ctx']);
  });

  it('an explicit dispose is idempotent on the interface; the owner still frees on exit, which the real composition ignores', async () => {
    // `Rerank.dispose` guards on its own `_disposed`, so the owner's free after an explicit dispose is a no-op
    // there; the fake counts both calls, and that count is the contract this row states.
    await run(function* () {
      const r = yield* createReranker('/fake/reranker.gguf');
      r.dispose();
      r.dispose();
      expect(rerankDispose).toHaveBeenCalledTimes(1);
    });
    expect(rerankDispose).toHaveBeenCalledTimes(2);
  });

  it('a halt while the context is still loading frees it when it arrives — the finding this row holds', async () => {
    let resolveCtx!: (c: typeof fakeCtx) => void;
    createContext.mockImplementationOnce(() => new Promise<typeof fakeCtx>((r) => { resolveCtx = r; }));
    await run(function* () {
      const task = yield* spawn(function* () { yield* createReranker('/fake/reranker.gguf'); });
      yield* sleep(0);
      yield* task.halt();
    });
    expect(fakeCtx.dispose).not.toHaveBeenCalled();
    resolveCtx(fakeCtx);
    await new Promise((r) => setTimeout(r, 0));
    expect(fakeCtx.dispose).toHaveBeenCalledTimes(1);
    expect(rerankCreate).not.toHaveBeenCalled();
  });
});
