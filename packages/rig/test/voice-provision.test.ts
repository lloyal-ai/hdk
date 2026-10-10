import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal, run, sleep, spawn } from 'effection';
import { modelSettings, mergeConfig } from '../src/config';
import { loadConfig } from '../src/config-layering';
import type { ModelFamily } from '../src/config';
import type { InstallCommand, InstallStepEvent } from '../src/install-protocol';

const { resolveModel, present } = vi.hoisted(() => ({ resolveModel: vi.fn(), present: new Set<string>() }));
vi.mock('../src/models', async original => ({
  ...await original<typeof import('../src/models')>(), resolveModel,
  isModelPresent: (_root: string, role: string, id: string) => present.has(`${role}/${id}`),
}));
const { install, planInstall } = await import('../src/install');
const { configuredServices, resolveServices, trunkOptions } = await import('../src/provision');
const decoder = 'qwen3-asr-0.6b-q8';
const projector = 'qwen3-asr-0.6b-mmproj-q8';
const family = (transcription: object = { id: decoder }): ModelFamily =>
  loadConfig(modelSettings, { model: { llm: { path: '/reasoning.gguf' }, transcription } }, { cwd: '/private/tmp', env: {} }).config.model;
beforeEach(() => {
  present.clear(); resolveModel.mockReset();
  resolveModel.mockImplementation(async ({ role, spec, onProgress }) => {
    onProgress?.(10, 20);
    return spec?.path ?? `/models/${role}/${spec?.id}.gguf`;
  });
});

describe('transcription provisioning', () => {
  it('enables only named services; defaults never request audio or cleanup', async () => {
    const empty = loadConfig(modelSettings, {}, { cwd: '/private/tmp', env: {} }).config.model;
    expect(configuredServices(empty)).toEqual([]);
    expect(await run(() => resolveServices([], { projectRoot: '/p', model: empty }))).toEqual({});
    expect(resolveModel).not.toHaveBeenCalled();
    expect(configuredServices(family())).toEqual(['transcription']);
  });

  it('plans a decoder and its own projector independently of the reasoning model vision tower', () => {
    const model = { ...family(), llm: { id: 'qwen3.5-4b' }, vision: {} };
    expect(planInstall(model).map(s => [s.id, s.role, s.spec])).toEqual([
      ['machine', undefined, undefined], ['llm', 'llm', { id: 'qwen3.5-4b' }],
      ['vision', 'vision', { id: 'qwen3.5-4b-mmproj' }],
      ['transcription', 'transcription', { id: decoder }],
      ['transcription.projector', 'transcription.projector', { id: projector }],
    ]);
  });

  it('uses explicit paths on both artifacts and never pairs a path decoder from its shadowed id', () => {
    const explicit = family({ id: decoder, path: '/asr.gguf', projector: { id: projector, path: '/audio.gguf' } });
    expect(planInstall(explicit).slice(2).map(s => s.spec)).toEqual([{ path: '/asr.gguf' }, { path: '/audio.gguf' }]);
    expect(() => planInstall(family({ id: decoder, path: '/asr.gguf' }))).toThrow(/transcription.projector/);
    expect(() => planInstall(family({ id: decoder, projector: { id: 'qwen3.5-4b-mmproj' } }))).toThrow(/projector|compatible/i);
  });

  it('refuses an incomplete pair before any acquisition, including the reasoning model', async () => {
    await expect(run(() => install({ projectRoot: '/p', model: family({ path: '/asr.gguf' }), totalBytes: 16 * 1024 ** 3, report: () => {} }))).rejects.toThrow(/transcription.projector/);
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it('acquires both through the existing resolver, reports projector progress and keeps it off the trunk', async () => {
    present.add(`transcription/${decoder}`);
    const events: InstallStepEvent[] = [];
    const result = await run(() => install({ projectRoot: '/p', model: family(), totalBytes: 16 * 1024 ** 3, report: e => events.push(e) }));
    expect(result.services).toMatchObject({ transcription: `/models/transcription/${decoder}.gguf`, 'transcription.projector': `/models/transcription.projector/${projector}.gguf` });
    expect(events.some(e => e.steps.some(s => s.id === 'transcription.projector' && s.got === 10))).toBe(true);
    expect(trunkOptions(result.services, result.model)).toEqual({});
    const resolved = await run(() => resolveServices(['transcription'], { projectRoot: '/p', model: family() }));
    expect(resolved).toEqual(result.services);
  });

  it('retries a failed projector without reacquiring its completed decoder', async () => {
    let attempts = 0;
    resolveModel.mockImplementation(async ({ role, spec }) => {
      if (role === 'transcription.projector' && attempts++ === 0) throw new Error('digest mismatch');
      return spec?.path ?? `/models/${role}/${spec.id}.gguf`;
    });
    const controls = createSignal<InstallCommand, void>();
    await run(function* () {
      const job = yield* spawn(() => install({ projectRoot: '/p', model: family(), totalBytes: 16 * 1024 ** 3, controls, report: e => {
        if (e.steps.some(s => s.status === 'failed')) controls.send({ type: 'install:retry' });
      } }));
      return yield* job;
    });
    expect(resolveModel.mock.calls.filter(([o]) => o.role === 'transcription')).toHaveLength(1);
    expect(attempts).toBe(2);
  });

  it('persists a projector file at its nested configuration key and aborts its download', async () => {
    let signal: AbortSignal | undefined;
    resolveModel.mockImplementation(async ({ role, spec, signal: next }) => {
      if (role !== 'transcription.projector' || spec.path) return spec?.path ?? `/models/${role}/${spec.id}.gguf`;
      signal = next;
      return new Promise((_resolve, reject) => next.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    let model = family(); const patches: unknown[] = [];
    const controls = createSignal<InstallCommand, void>();
    const result = await run(function* () {
      const job = yield* spawn(() => install({ projectRoot: '/p', model, totalBytes: 16 * 1024 ** 3, controls, report: () => {}, persist: patch => {
        patches.push(patch);
        model = mergeConfig(modelSettings, { version: 2, abilities: {}, sources: {}, model }, patch).model;
        return model;
      } }));
      yield* sleep(5);
      controls.send({ type: 'install:use_file', step: 'transcription.projector', path: '/local/audio.gguf' });
      return yield* job;
    });
    expect(signal?.aborted).toBe(true);
    expect(patches).toEqual([{ model: { transcription: { projector: { path: '/local/audio.gguf' } } } }]);
    expect(result.services['transcription.projector']).toBe('/local/audio.gguf');
  });
});
