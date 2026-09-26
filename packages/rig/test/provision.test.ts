/**
 * The framework's side of the service contract: the services a configuration names are the ones
 * provisioned, each one's artifact is resolved into its slot, its row binds it, and the bound
 * instance is what `service(name)` answers. `resolveModel` (verified native fetch) and
 * `createReranker` (loads a model context) are mocked — the unit under test is the walk over
 * the rows, not the fetch or the native runtime.
 *
 * @category Testing
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { run } from 'effection';
import { service } from '../src/services';
import type { Reranker } from '../src/retrieval';

const RERANKER_PATH = '/fake/models/reranker/qwen3-reranker-0.6b-q8.gguf';

const { resolveModel, createReranker, fakeReranker } = vi.hoisted(() => {
  const fakeReranker = { id: 'fake-reranker' } as unknown as Reranker;
  return {
    fakeReranker,
    resolveModel: vi.fn(async (_spec?: unknown, _opts?: unknown) => '/fake/models/reranker/qwen3-reranker-0.6b-q8.gguf'),
    createReranker: vi.fn(() =>
      (function* () {
        return fakeReranker;
      })(),
    ),
  };
});

vi.mock('../src/models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/models')>();
  return { ...actual, resolveModel };
});
vi.mock('../src/providers/reranker', () => ({ createReranker }));

// Import under test AFTER the mocks are registered.
const { configuredServices, resolveServices, bindServices, trunkOptions } = await import('../src/provision');

beforeEach(() => {
  resolveModel.mockClear();
  createReranker.mockClear();
});

describe('configuredServices: naming a block is the request', () => {
  it('every service whose block is present, in the table\'s order; an empty block counts; an absent one does not', () => {
    expect(configuredServices({ reranker: { context: 16384 } })).toEqual(['reranker']);
    expect(configuredServices({ reranker: { id: 'r', context: 16384 }, llm: { id: 'q' } })).toEqual(['reranker']);
    expect(configuredServices({ llm: { id: 'q' } })).toEqual([]);
    expect(configuredServices({})).toEqual([]);
  });
});

describe('resolveServices: what a boot must have on disk, before anything loads', () => {
  it('nothing required → nothing resolved', async () => {
    const artifacts = await run(function* () { return yield* resolveServices([], { projectRoot: '/proj', model: {} }); });
    expect(artifacts).toEqual({});
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it('a required reranker resolves into its slot from the block\'s selection: path over id', async () => {
    await run(function* () {
      yield* resolveServices(['reranker'], { projectRoot: '/proj', model: { reranker: { id: 'custom', path: '/weights/my.gguf', context: 16384 } } });
    });
    expect(resolveModel.mock.calls[0][0]).toMatchObject({ role: 'reranker', projectRoot: '/proj', spec: { path: '/weights/my.gguf' } });
    await run(function* () {
      yield* resolveServices(['reranker'], { projectRoot: '/proj', model: { reranker: { id: 'custom', context: 16384 } } });
    });
    expect(resolveModel.mock.calls[1][0]).toMatchObject({ spec: { id: 'custom' } });
  });

  it('a block that names no model is a request nothing can satisfy: refused, naming the keys that would', async () => {
    await expect(run(function* () {
      return yield* resolveServices(['reranker'], { projectRoot: '/proj', model: { reranker: { context: 4096 } } });
    })).rejects.toThrow('`model.reranker` names no model — set `model.reranker.id` (a catalog id) or `model.reranker.path` in harness.yml');
    expect(resolveModel).not.toHaveBeenCalled();
    expect(createReranker).not.toHaveBeenCalled();
  });

  it('resolves what it is asked for and nothing else — and never loads', async () => {
    const artifacts = await run(function* () {
      return yield* resolveServices(['reranker'], { projectRoot: '/proj', model: { reranker: { id: 'qwen3-reranker-0.6b-q8', context: 16384 } } });
    });
    expect(artifacts).toEqual({ reranker: RERANKER_PATH });
    expect(createReranker).not.toHaveBeenCalled();
  });
});

describe('bindServices: each artifact through its row, into reach', () => {
  it('the reranker row binds with the block\'s tuning, and service(\'reranker\') answers the bound instance', async () => {
    const seen = await run(function* () {
      yield* bindServices({ reranker: RERANKER_PATH }, { reranker: { context: 8192 } });
      return yield* service('reranker');
    });
    expect(createReranker).toHaveBeenCalledWith(RERANKER_PATH, { nCtx: 8192, instruction: undefined });
    expect(seen).toBe(fakeReranker);
  });

  it('the block reaches the row as the layering resolved it — its default context, its instruction', async () => {
    const instruction = { text: 'Is this passage relevant?', smokeTest: 'none' as const };
    await run(function* () {
      yield* bindServices({ reranker: RERANKER_PATH }, { reranker: { context: 16384, instruction } });
    });
    expect(createReranker).toHaveBeenCalledWith(RERANKER_PATH, { nCtx: 16384, instruction });
  });

  it('a trunk row: its artifact is on the resident context, and service(name) answers that it is there', async () => {
    const seen = await run(function* () {
      yield* bindServices({ vision: '/proj/models/vision/p.gguf' }, { vision: { minTokens: 64 } });
      return yield* service('vision');
    });
    expect(seen).toEqual({ artifact: '/proj/models/vision/p.gguf' });
    expect(createReranker).not.toHaveBeenCalled();
    expect(trunkOptions({ vision: '/proj/models/vision/p.gguf' }, { vision: { minTokens: 64 } })).toEqual({ mmprojPath: '/proj/models/vision/p.gguf', imageMinTokens: 64, imageMaxTokens: undefined });
    expect(trunkOptions({ reranker: '/r.gguf' }, { reranker: { context: 16384 } })).toEqual({});
  });

  it('a service with a derivation resolves what the row derives when its block selects nothing', async () => {
    await run(function* () { yield* resolveServices(['vision'], { projectRoot: '/proj', model: { llm: { id: 'qwen3.5-4b' }, vision: {} } }); });
    expect(resolveModel.mock.calls[0][0]).toMatchObject({ role: 'vision', spec: { id: 'qwen3.5-4b-mmproj' } });
  });

  it('nothing to bind → nothing in reach, and the accessor refuses by name', async () => {
    await expect(run(function* () {
      yield* bindServices({}, {});
      return yield* service('reranker');
    })).rejects.toThrow(/`reranker` is not configured/);
    expect(createReranker).not.toHaveBeenCalled();
  });
});
