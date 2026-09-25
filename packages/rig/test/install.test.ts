/**
 * The install: steps derived from the model family, acquired as one walk, reported as whole
 * snapshots, held where a view can offer a remedy and ended where none can. `resolveModel` is
 * mocked to say what it was asked and to fail, stall or answer on cue; the walk is the unit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { run, createSignal, sleep, spawn } from 'effection';
import type { Operation } from 'effection';
import { DownloadStopped } from '../src/models';
import type { InstallCommand, InstallStepEvent } from '../src/install-protocol';

const { resolveModel, present } = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  present: new Set<string>(),
}));
vi.mock('../src/models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/models')>();
  return { ...actual, resolveModel, isModelPresent: (_root: string, role: string, id: string) => present.has(`${role}/${id}`), carryOverVisionSlot: () => {} };
});
const { install, planInstall } = await import('../src/install');

const GB = 1024 ** 3;
type Asked = { role: string; spec?: { id?: string; path?: string }; signal?: AbortSignal; onProgress?: (got: number, total: number) => void };
const asked: Asked[] = [];
/** Answer every resolve with the slot path at once. */
const answering = (): void => {
  resolveModel.mockImplementation(async (o: Asked) => { asked.push(o); return `/proj/models/${o.role}/${o.spec?.id ?? o.spec?.path ?? 'adopted'}.gguf`; });
};

beforeEach(() => {
  asked.length = 0;
  present.clear();
  resolveModel.mockReset();
  answering();
});

const ids = (ev: InstallStepEvent): string => ev.steps.map((s) => `${s.id}:${s.status}`).join(' ');

describe('planInstall: the steps, from the model family alone', () => {
  it('the machine, the model, then every configured service in the table\'s order — each with its spec, derived where the block names none', () => {
    const steps = planInstall({ llm: { id: 'qwen3.5-4b' }, vision: {}, reranker: { id: 'r', context: 16384 } });
    expect(steps.map((s) => [s.id, s.role, s.spec])).toEqual([
      ['machine', undefined, undefined],
      ['llm', 'llm', { id: 'qwen3.5-4b' }],
      ['reranker', 'reranker', { id: 'r' }],
      ['vision', 'vision', { id: 'qwen3.5-4b-mmproj' }],
    ]);
    expect(planInstall({ llm: { path: '/m.gguf' } }).map((s) => s.id)).toEqual(['machine', 'llm']);
    expect(planInstall({}).map((s) => [s.id, s.spec])).toEqual([['machine', undefined], ['llm', undefined]]);
  });

  it('a step whose block takes a path says a file may stand in; the machine step never does', () => {
    const steps = planInstall({ llm: { id: 'qwen3.5-4b' }, vision: {}, reranker: { path: '/r', context: 16384 } });
    expect(steps.map((s) => [s.id, s.file])).toEqual([['machine', undefined], ['llm', true], ['reranker', true], ['vision', true]]);
  });

  it('a block that names nothing it can is refused before anything runs — and says when a derivation was tried', () => {
    expect(() => planInstall({ llm: { path: '/m.gguf' }, vision: {} })).toThrow('`model.vision` names no model and none follows from the llm — set `model.vision.id` (a catalog id) or `model.vision.path` in harness.yml');
    expect(() => planInstall({ llm: { id: 'unknown-llm' }, vision: {} })).toThrow(/none follows from the llm/);
    expect(() => planInstall({ llm: { id: 'q' }, reranker: { context: 16384 } })).toThrow('`model.reranker` names no model — set `model.reranker.id` (a catalog id) or `model.reranker.path` in harness.yml');
    expect(planInstall({ llm: { path: '/m.gguf' }, vision: { id: 'other' } })[2].spec).toEqual({ id: 'other' });
  });
});

describe('install: a run that acquires nothing reports nothing', () => {
  it('every artifact already in its slot → resolved, and not one snapshot sent', async () => {
    present.add('llm/qwen3.5-4b').add('reranker/r');
    const sent: InstallStepEvent[] = [];
    const acquired = await run(() => install({ projectRoot: '/proj', model: { llm: { id: 'qwen3.5-4b' }, reranker: { id: 'r', context: 16384 } }, totalBytes: 16 * GB, report: (ev) => sent.push(ev) }));
    expect(sent).toEqual([]);
    expect(acquired.llm).toBe('/proj/models/llm/qwen3.5-4b.gguf');
    expect(acquired.services).toEqual({ reranker: '/proj/models/reranker/r.gguf' });
    expect(acquired.services.vision).toBeUndefined();
  });

  it('cached weights on an undersized machine: the failed machine row is published before the run ends', async () => {
    present.add('llm/qwen3.5-4b');
    const sent: InstallStepEvent[] = [];
    await expect(run(() => install({ projectRoot: '/proj', model: { llm: { id: 'qwen3.5-4b' } }, totalBytes: 8 * GB, report: (ev) => sent.push(ev) })))
      .rejects.toThrow(/needs about 10 GB of memory and this machine has 8 GB/);
    expect(sent).toHaveLength(1);
    expect(ids(sent[0])).toBe('machine:failed llm:pending');
    expect(sent[0].steps[0].note).toBe('8 GB · 10 GB needed');
    expect(resolveModel).not.toHaveBeenCalled();
  });
});

describe('install: a run that acquires', () => {
  it('announces every step at once, moves each through running → done with its bytes, and clears when over', async () => {
    const sent: InstallStepEvent[] = [];
    resolveModel.mockImplementation(async (o: Asked) => { asked.push(o); o.onProgress?.(1, 4); o.onProgress?.(4, 4); return `/proj/models/${o.role}/${o.spec!.id}.gguf`; });
    const acquired = await run(() => install({ projectRoot: '/proj', model: { llm: { id: 'qwen3.5-4b' }, vision: {} }, totalBytes: 16 * GB, report: (ev) => sent.push(ev) }));
    expect(sent[0].steps.map((s) => s.status)).toEqual(['done', 'pending', 'pending']);
    expect(sent[0].steps[0].note).toBe('16 GB · 10 GB needed');
    expect(sent.map(ids)).toContain('machine:done llm:running vision:pending');
    expect(sent.find((ev) => ev.steps[1]?.got === 1)?.steps[1]).toMatchObject({ status: 'running', got: 1, total: 4 });
    expect(sent.map(ids)).toContain('machine:done llm:done vision:running');
    expect(sent.at(-1)!.steps).toEqual([]);
    // Every frame is its own copy: a later change never rewrites a sent one.
    expect(sent[0].steps[1].status).toBe('pending');
    expect(acquired.services.vision).toBe('/proj/models/vision/qwen3.5-4b-mmproj.gguf');
    expect(sent.find((ev) => ev.steps[1]?.status === 'done')?.steps[1].note).toBe('Qwen3.5 4B · Q4_K_M');
  });

  it('a step that fails with no view to hold for ends the run — after its row says why', async () => {
    resolveModel.mockRejectedValueOnce(new Error('Failed to fetch Qwen3.5 4B from any source'));
    const sent: InstallStepEvent[] = [];
    await expect(run(() => install({ projectRoot: '/proj', model: { llm: { id: 'qwen3.5-4b' } }, totalBytes: 16 * GB, report: (ev) => sent.push(ev) })))
      .rejects.toThrow(/Failed to fetch/);
    expect(sent.at(-1)!.steps[1]).toMatchObject({ status: 'failed', note: 'Failed to fetch Qwen3.5 4B from any source' });
  });

  it('with a view, a failed step holds: retry resolves it again; quit ends the run', async () => {
    resolveModel.mockRejectedValueOnce(new Error('offline'));
    const sent: InstallStepEvent[] = [];
    const controls = createSignal<InstallCommand, void>();
    const acquired = await run(function* () {
      const task = yield* spawn(() => install({ projectRoot: '/proj', model: { llm: { id: 'qwen3.5-4b' } }, totalBytes: 16 * GB, report: (ev) => sent.push(ev), controls, persist: () => ({}) }));
      yield* sleep(10);
      expect(sent.at(-1)!.steps[1].status).toBe('failed');
      controls.send({ type: 'install:retry' });
      return yield* task;
    });
    expect(acquired.llm).toBe('/proj/models/llm/qwen3.5-4b.gguf');
    expect(resolveModel).toHaveBeenCalledTimes(2);
    expect(sent.at(-1)!.steps).toEqual([]);

    resolveModel.mockRejectedValueOnce(new Error('offline'));
    await expect(run(function* () {
      const task = yield* spawn(() => install({ projectRoot: '/proj', model: { llm: { id: 'qwen3.5-4b' } }, totalBytes: 16 * GB, report: () => {}, controls, persist: () => ({}) }));
      yield* sleep(10);
      controls.send({ type: 'install:quit' });
      return yield* task;
    })).rejects.toThrow(/the install was stopped/);
  });

  it('a file chosen during a download: remembered first, the download stopped, the step re-resolved from the file, the rest untouched', async () => {
    // The first resolve is a download that only ends when its signal says so.
    resolveModel.mockImplementationOnce((o: Asked) => new Promise((_resolve, reject) => {
      asked.push(o);
      o.signal!.addEventListener('abort', () => reject(new DownloadStopped()));
    }));
    const sent: InstallStepEvent[] = [];
    const controls = createSignal<InstallCommand, void>();
    const persisted: unknown[] = [];
    const acquired = await run(function* () {
      const task = yield* spawn(() => install({
        projectRoot: '/proj', model: { llm: { id: 'qwen3.5-4b' }, reranker: { id: 'r', context: 16384 } }, totalBytes: 16 * GB,
        report: (ev) => sent.push(ev), controls,
        persist: (patch) => { persisted.push(patch); return { llm: { id: 'qwen3.5-4b', path: (patch.model as { llm: { path: string } }).llm.path }, reranker: { id: 'r', context: 16384 } }; },
      }));
      yield* sleep(10);
      expect(sent.at(-1)!.steps[1].status).toBe('running');
      controls.send({ type: 'install:use_file', step: 'llm', path: '/weights/mine.gguf' });
      return yield* task;
    });
    expect(persisted).toEqual([{ model: { llm: { path: '/weights/mine.gguf' } } }]);
    expect(asked.map((a) => [a.role, a.spec])).toEqual([['llm', { id: 'qwen3.5-4b' }], ['llm', { path: '/weights/mine.gguf' }], ['reranker', { id: 'r' }]]);
    expect(acquired.llm).toBe('/proj/models/llm//weights/mine.gguf.gguf');
    expect(acquired.model.llm?.path).toBe('/weights/mine.gguf');
    expect(sent.at(-1)!.steps).toEqual([]);
  });

  it('a file chosen with nothing to remember it is refused, never silently forgotten', async () => {
    resolveModel.mockRejectedValueOnce(new Error('offline'));
    const controls = createSignal<InstallCommand, void>();
    await expect(run(function* (): Operation<unknown> {
      const task = yield* spawn(() => install({ projectRoot: '/proj', model: { llm: { id: 'qwen3.5-4b' } }, totalBytes: 16 * GB, report: () => {}, controls }));
      yield* sleep(10);
      controls.send({ type: 'install:use_file', step: 'llm', path: '/w.gguf' });
      return yield* task;
    })).rejects.toThrow(/`persist` is required beside `controls`/);
  });
});
