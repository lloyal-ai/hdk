/**
 * Tests for {@link provisionAbilityModels} — the boot helper that reads the
 * aggregate service requirements (`manifest.services`, carried on each
 * `AbilityFactory`) of an ability set and provisions the auxiliary models (today: the
 * shared reranker, published on `RerankerCtx`).
 *
 * `resolveModel` (verified native fetch) and `createReranker` (loads a model
 * context) are mocked — the unit under test is the aggregation + wiring, not
 * the fetch or the native runtime.
 *
 * @category Testing
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { run } from 'effection';
import { RerankerCtx } from '@lloyal-labs/lloyal-agents';
import type { AbilityFactory, Ability, AbilityManifest, Reranker } from '@lloyal-labs/lloyal-agents';
import type { ModelSpec } from '../src/models';

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
vi.mock('../src/reranker', () => ({ createReranker }));

// Import under test AFTER the mocks are registered.
const { provisionAbilityModels, resolveAbilityModels } = await import('../src/provision');

/** A factory that carries its manifest statically and throws if actually run. */
function factory(services?: readonly ('reranker' | 'embedding')[]): AbilityFactory {
  const f = function* (): Generator<never, Ability, unknown> {
    throw new Error('provisionAbilityModels must NOT run the factory');
  };
  const manifest = {
    name: 'test',
    protocol: { name: 'test_research', useWhen: 'testing', tools: ['test_tool'] },
    ...(services ? { services } : {}),
  } as AbilityManifest;
  return Object.assign(f as unknown as AbilityFactory, { manifest });
}

beforeEach(() => {
  resolveModel.mockClear();
  createReranker.mockClear();
});

describe('provisionAbilityModels', () => {
  it('a reranker requirement → resolves, creates, and sets RerankerCtx', async () => {
    const bound = await run(function* () {
      yield* provisionAbilityModels({
        abilities: [factory(['reranker']), factory()],
        projectRoot: '/proj',
      });
      return yield* RerankerCtx.expect();
    });
    expect(resolveModel).toHaveBeenCalledOnce();
    expect(resolveModel.mock.calls[0][0]).toMatchObject({ role: 'reranker', projectRoot: '/proj' });
    expect(createReranker).toHaveBeenCalledWith(RERANKER_PATH, undefined);
    expect(bound).toBe(fakeReranker);
  });

  it('no requirements → no-op (nothing resolved, RerankerCtx never set)', async () => {
    const unset = await run(function* () {
      yield* provisionAbilityModels({ abilities: [factory(), factory()], projectRoot: '/proj' });
      try {
        yield* RerankerCtx.expect();
        return false; // set — unexpected
      } catch {
        return true; // unset — expected
      }
    });
    expect(unset).toBe(true);
    expect(resolveModel).not.toHaveBeenCalled();
    expect(createReranker).not.toHaveBeenCalled();
  });

  it('an empty ability set → no-op', async () => {
    await run(function* () {
      yield* provisionAbilityModels({ abilities: [], projectRoot: '/proj' });
    });
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it('an embedding requirement → throws (reserved, not yet implemented)', async () => {
    await expect(
      run(function* () {
        yield* provisionAbilityModels({ abilities: [factory(['embedding'])], projectRoot: '/proj' });
      }),
    ).rejects.toThrow(/embedding/);
  });

  it('a reranker + reserved embedding requirement fails fast — no reranker is loaded', async () => {
    await expect(
      run(function* () {
        yield* provisionAbilityModels({
          abilities: [factory(['reranker']), factory(['embedding'])],
          projectRoot: '/proj',
        });
      }),
    ).rejects.toThrow(/embedding/);
    expect(createReranker).not.toHaveBeenCalled();
  });

  it('a harness.yml reranker spec is passed through to resolveModel', async () => {
    await run(function* () {
      yield* provisionAbilityModels({
        abilities: [factory(['reranker'])],
        projectRoot: '/proj',
        reranker: { id: 'custom-reranker' },
      });
    });
    expect(resolveModel.mock.calls[0][0]).toMatchObject({ spec: { id: 'custom-reranker' } });
  });

  it('an id-less reranker spec (only tuning, e.g. context) falls back to the catalog default', async () => {
    await run(function* () {
      yield* provisionAbilityModels({
        abilities: [factory(['reranker'])],
        projectRoot: '/proj',
        // A `reranker:` block that tunes but names no model — must NOT block the fallback.
        reranker: { context: 4096 } as unknown as ModelSpec,
      });
    });
    expect(resolveModel.mock.calls[0][0]).toMatchObject({ spec: { id: 'qwen3-reranker-0.6b-q8' } });
  });

  it('duplicate reranker requirements load the shared reranker once', async () => {
    await run(function* () {
      yield* provisionAbilityModels({
        abilities: [factory(['reranker']), factory(['reranker']), factory(['reranker'])],
        projectRoot: '/proj',
      });
    });
    expect(createReranker).toHaveBeenCalledOnce();
  });

  it('rerankerLoad is threaded into createReranker (tuning the shared reranker)', async () => {
    await run(function* () {
      yield* provisionAbilityModels({
        abilities: [factory(['reranker'])],
        projectRoot: '/proj',
        rerankerLoad: { nCtx: 16384 },
      });
    });
    expect(createReranker).toHaveBeenCalledWith(RERANKER_PATH, { nCtx: 16384 });
  });
});

/**
 * The same requirement, asked before anything is loaded: what a boot must have on
 * disk before it can serve. A served host needs this separately from the load,
 * because its fetch happens once at boot while the load happens per session — but
 * it is the SAME requirement, read off the abilities, never assumed.
 */
describe('resolveAbilityModels: what a boot must have on disk', () => {
  it('an ability set that declares no service needs nothing — a boot without a reranker never reaches for one', async () => {
    const models = await run(function* () {
      return yield* resolveAbilityModels({ abilities: [factory(), factory()], projectRoot: '/proj' });
    });
    expect(models).toEqual({});
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it('an empty ability set with no reranker configured needs nothing', async () => {
    const models = await run(function* () {
      return yield* resolveAbilityModels({ abilities: [], projectRoot: '/proj' });
    });
    expect(models).toEqual({});
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it('a declared reranker requirement resolves the catalog default — and loads nothing yet', async () => {
    const models = await run(function* () {
      return yield* resolveAbilityModels({ abilities: [factory(['reranker'])], projectRoot: '/proj' });
    });
    expect(models).toEqual({ reranker: RERANKER_PATH });
    expect(resolveModel.mock.calls[0][0]).toMatchObject({ role: 'reranker', spec: { id: 'qwen3-reranker-0.6b-q8' } });
    expect(createReranker).not.toHaveBeenCalled();
  });

  it('an explicit spec names the model the requirement resolves to', async () => {
    await run(function* () {
      return yield* resolveAbilityModels({
        abilities: [factory(['reranker'])],
        projectRoot: '/proj',
        reranker: { path: '/weights/my-reranker.gguf' },
      });
    });
    expect(resolveModel.mock.calls[0][0]).toMatchObject({ spec: { path: '/weights/my-reranker.gguf' } });
  });

  it('a reserved embedding requirement fails fast, before anything is resolved', async () => {
    await expect(
      run(function* () {
        return yield* resolveAbilityModels({ abilities: [factory(['embedding'])], projectRoot: '/proj' });
      }),
    ).rejects.toThrow(/embedding/);
    expect(resolveModel).not.toHaveBeenCalled();
  });
});
