/**
 * The embedding service's projector: a multimodal embedding model plans and
 * acquires the projector it is paired with, and a text-only one plans none.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal, run, spawn } from 'effection';
import type { InstallCommand, InstallStepEvent } from '../src/install-protocol';
import { modelSettings } from '../src/config';
import { loadConfig } from '../src/config-layering';
import type { ModelFamily } from '../src/config';

const { resolveModel } = vi.hoisted(() => ({ resolveModel: vi.fn() }));
vi.mock('../src/models', async original => ({
  ...await original<typeof import('../src/models')>(), resolveModel, isModelPresent: () => false,
}));
const { createEmbedder } = vi.hoisted(() => ({ createEmbedder: vi.fn(function* (_path: string, _opts: { nCtx?: number; framing?: object; dimensions?: number[]; imageMinTokens?: number; imageMaxTokens?: number }) { return {}; }) }));
vi.mock('../src/providers/embedding', () => ({ createEmbedder }));
const { install, planInstall } = await import('../src/install');
const { bindServices, refusalOf, resolveServices } = await import('../src/provision');
const { catalogEntry } = await import('../src/models');

const model = 'embeddinggemma-2-q8';
const projector = 'embeddinggemma-2-mmproj-bf16';
const family = (embedding: object): ModelFamily =>
  loadConfig(modelSettings, { model: { llm: { path: '/reasoning.gguf' }, embedding } }, { cwd: '/private/tmp', env: {} }).config.model;
const planned = (embedding: object) => planInstall(family(embedding)).slice(2).map(s => [s.role, s.spec]);

beforeEach(() => {
  resolveModel.mockReset();
  resolveModel.mockImplementation(async ({ role, spec }) => spec?.path ?? `/models/${role}/${spec?.id}.gguf`);
});

describe('embedding provisioning', () => {
  it('plans EmbeddingGemma 2 and the projector the catalog pairs it with', () => {
    expect(planned({ id: model })).toEqual([['embedding', { id: model }], ['embedding.projector', { id: projector }]]);
    expect(catalogEntry('embedding', model)?.pooling).toBe('mean');
  });

  it('takes EmbeddingGemma 2 and its projector for a block that names no model: the default embedding service', () => {
    expect(planned({})).toEqual([['embedding', { id: model }], ['embedding.projector', { id: projector }]]);
    // A local file outranks the default, and the catalog pairs it with nothing.
    expect(planned({ path: '/embed.gguf', pooling: 'mean' })).toEqual([['embedding', { path: '/embed.gguf' }]]);
  });

  it('refuses, before anything is fetched, a model the catalog does not carry', () => {
    expect(refusalOf('embedding', family({ id: 'qwen3-embedding-0.6b-q8' }))).toMatch(/pooling the catalog does not know/);
  });

  it('plans one step for a text-only embedding model', () => {
    expect(planned({ id: 'nomic-embed-text-v1.5-q4' })).toEqual([['embedding', { id: 'nomic-embed-text-v1.5-q4' }]]);
  });

  it('takes explicit paths, and refuses a projector id that is not the model\'s pair', () => {
    expect(planned({ path: '/embed.gguf', pooling: 'mean', projector: { path: '/mmproj.gguf' } }))
      .toEqual([['embedding', { path: '/embed.gguf' }], ['embedding.projector', { path: '/mmproj.gguf' }]]);
    expect(() => planInstall(family({ id: model, projector: { id: 'qwen3.5-4b-mmproj' } }))).toThrow(/model\.embedding\.projector\.id.*compatible/);
  });

  it('acquires the projector beside the model', async () => {
    const artifacts = await run(() => resolveServices(['embedding'], { projectRoot: '/p', model: family({ id: model }) }));
    expect(artifacts).toEqual({ embedding: `/models/embedding/${model}.gguf`, 'embedding.projector': `/models/embedding.projector/${projector}.gguf` });
  });

  it('installs the projector on the path both boots take: its own step and progress, retried alone when it fails', async () => {
    let attempts = 0;
    resolveModel.mockImplementation(async ({ role, spec, onProgress }) => {
      if (role === 'embedding.projector' && attempts++ === 0) throw new Error('digest mismatch');
      onProgress?.(10, 20);
      return `/models/${role}/${spec.id}.gguf`;
    });
    const events: InstallStepEvent[] = [];
    const controls = createSignal<InstallCommand, void>();
    const result = await run(function* () {
      const job = yield* spawn(() => install({ projectRoot: '/p', model: family({ id: model }), totalBytes: 16 * 1024 ** 3, controls, report: e => {
        events.push(e);
        if (e.steps.some(s => s.status === 'failed')) controls.send({ type: 'install:retry' });
      } }));
      return yield* job;
    });
    expect(result.services).toMatchObject({ embedding: `/models/embedding/${model}.gguf`, 'embedding.projector': `/models/embedding.projector/${projector}.gguf` });
    expect(events.some(e => e.steps.some(s => s.id === 'embedding.projector' && s.got === 10))).toBe(true);
    // The model it already has is not fetched again for its projector's retry.
    expect(resolveModel.mock.calls.filter(([o]) => o.role === 'embedding')).toHaveLength(1);
  });

  it('refuses, before anything is fetched, a context longer than the catalog model was trained to read', () => {
    const refused = (embedding: object) => refusalOf('embedding', family(embedding));
    expect(refused({ id: model, context: 8192 })).toBeUndefined();
    expect(refused({ id: model, context: 16384 })).toMatch(/model\.embedding\.context.*16384.*embeddinggemma-2-q8.*8192/);
    expect(refused({ id: 'nomic-embed-text-v1.5-q4', context: 4096 })).toMatch(/model\.embedding\.context.*4096.*2048/);
    // A `path:` model is the harness's own file, and the catalog knows nothing of what it was trained to read.
    expect(refused({ path: '/embed.gguf', pooling: 'mean', context: 65536 })).toBeUndefined();
  });

  it('refuses image detail outside the range the paired projector projects an image into, or set where nothing reads it', () => {
    const refused = (embedding: object) => refusalOf('embedding', family(embedding));
    expect(refused({ id: model, vision: { minTokens: 70, maxTokens: 280 } })).toBeUndefined();
    expect(refused({ id: model, vision: { maxTokens: 2000 } })).toMatch(/model\.embedding\.vision\.maxTokens.*2000.*70 to 1120/);
    expect(refused({ id: model, vision: { minTokens: 35 } })).toMatch(/model\.embedding\.vision\.minTokens.*35.*70 to 1120/);
    expect(refused({ id: model, vision: { minTokens: 560, maxTokens: 280 } })).toMatch(/minTokens.*560.*above.*maxTokens.*280/);
    expect(refused({ id: 'nomic-embed-text-v1.5-q4', vision: { maxTokens: 280 } })).toMatch(/model\.embedding\.vision.*no projector/);
    // A projector named by path is the harness's own file: its range is its own to know.
    expect(refused({ path: '/embed.gguf', pooling: 'mean', projector: { path: '/mmproj.gguf' }, vision: { maxTokens: 5000 } })).toBeUndefined();
  });

  it('takes the context its catalog entry gives when the block sets none, and the one the block says otherwise', async () => {
    const context = async (embedding: object) => {
      createEmbedder.mockClear();
      await run(() => bindServices({ embedding: '/models/e.gguf' }, family(embedding)));
      return createEmbedder.mock.calls[0][1].nCtx;
    };
    expect(await context({})).toBe(8192);
    expect(await context({ id: 'nomic-embed-text-v1.5-q4' })).toBe(2048);
    expect(await context({ id: model, context: 4096 })).toBe(4096);
    // A local file's trained context is the harness's to know: the embedder's own default stands.
    expect(await context({ path: '/embed.gguf', pooling: 'mean' })).toBeUndefined();
  });

  it('binds the image detail the block sets onto the projector', async () => {
    createEmbedder.mockClear();
    await run(() => bindServices({ embedding: `/models/${model}.gguf`, 'embedding.projector': '/mmproj.gguf' }, family({ id: model, vision: { minTokens: 140, maxTokens: 280 } })));
    expect(createEmbedder.mock.calls[0][1]).toMatchObject({ projector: '/mmproj.gguf', imageMinTokens: 140, imageMaxTokens: 280 });
  });

  it('binds each catalog model with the task framing and trained widths its own card gives', async () => {
    const bound = async (id: string) => {
      createEmbedder.mockClear();
      await run(() => bindServices({ embedding: `/models/${id}.gguf` }, family({ id })));
      return createEmbedder.mock.calls[0][1];
    };
    const query = (task: string) => `task: ${task} | query: `;
    const asymmetric = (task: string) => ({ query: query(task), document: 'title: none | text: ', titled: 'title: {title} | text: ' });
    const symmetric = (task: string) => ({ query: query(task), document: query(task) });
    expect(await bound(model)).toMatchObject({
      dimensions: [768, 512, 256, 128],
      framing: {
        search: asymmetric('search result'),
        'question-answering': asymmetric('question answering'),
        'fact-checking': asymmetric('fact checking'),
        'code-retrieval': asymmetric('code retrieval'),
        classification: symmetric('classification'),
        clustering: symmetric('clustering'),
        similarity: symmetric('sentence similarity'),
      },
    });
    expect(await bound('nomic-embed-text-v1.5-q4')).toMatchObject({
      dimensions: [768, 512, 256, 128, 64],
      framing: {
        search: { query: 'search_query: ', document: 'search_document: ' },
        classification: { query: 'classification: ', document: 'classification: ' },
        clustering: { query: 'clustering: ', document: 'clustering: ' },
      },
    });
  });
});
