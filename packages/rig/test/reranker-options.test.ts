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
import { run } from 'effection';

const { createContext, fakeCtx } = vi.hoisted(() => {
  const fakeCtx = {
    _storeKvPressure: () => ({ nCtx: 4096, cellsUsed: 0, remaining: 4096 }),
    tokenize: async () => [1],
    dispose: vi.fn(),
  };
  return { fakeCtx, createContext: vi.fn(async () => fakeCtx) };
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

  it('requests q4_0 for both KV types when the caller specifies neither', async () => {
    await load();
    expect(createContext).toHaveBeenCalledTimes(1);
    const args = createContext.mock.calls[0][0] as Record<string, unknown>;
    expect(args.typeK).toBe('q4_0');
    expect(args.typeV).toBe('q4_0');
  });

  it('requests the caller\'s KV types when given', async () => {
    await load({ typeK: 'f16', typeV: 'f16' });
    const args = createContext.mock.calls[0][0] as Record<string, unknown>;
    expect(args.typeK).toBe('f16');
    expect(args.typeV).toBe('f16');
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

describe('createReranker — failed boot disposes the context', () => {
  beforeEach(() => {
    createContext.mockClear();
    rerankCreate.mockClear();
    fakeCtx.dispose.mockClear();
  });

  it('disposes exactly once when Rerank.create rejects', async () => {
    // A failing smoke test is now a normal configuration outcome, and the
    // throw escapes before `provide`, so the resource's own try/finally never
    // runs. Without the explicit dispose the caller's context leaks on every
    // rejected boot.
    rerankCreate.mockRejectedValueOnce(new Error('smoke test failed'));
    await expect(
      run(function* () {
        yield* createReranker('/fake/reranker.gguf');
      }),
    ).rejects.toThrow('smoke test failed');
    expect(fakeCtx.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not dispose on a successful boot', async () => {
    // Guards the other direction: a dispose in the success path would hand
    // back a reranker whose context is already gone.
    await run(function* () {
      yield* createReranker('/fake/reranker.gguf');
    });
    expect(fakeCtx.dispose).not.toHaveBeenCalled();
  });
});

describe('createReranker — successful lifecycle', () => {
  beforeEach(() => {
    createContext.mockClear();
    rerankCreate.mockClear();
    rerankDispose.mockClear();
    fakeCtx.dispose.mockClear();
  });

  it('teardown delegates disposal to Rerank, which owns the context', async () => {
    // rig must NOT dispose ctx itself on the success path: Rerank.dispose()
    // already does, and a second call would double-dispose.
    await run(function* () {
      yield* createReranker('/fake/reranker.gguf');
    });
    expect(rerankDispose).toHaveBeenCalledTimes(1);
    expect(fakeCtx.dispose).not.toHaveBeenCalled();
  });

  it('explicit dispose followed by teardown delegates only once', async () => {
    await run(function* () {
      const r = yield* createReranker('/fake/reranker.gguf');
      r.dispose();
      expect(rerankDispose).toHaveBeenCalledTimes(1);
    });
    expect(rerankDispose).toHaveBeenCalledTimes(1);
  });
});
