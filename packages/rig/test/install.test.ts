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
  return { ...actual, resolveModel, isModelPresent: (_root: string, role: string, id: string) => present.has(`${role}/${id}`) };
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

  it('a block whose selection the row still cannot bind is refused at plan time — before a byte is fetched — and marked failed when the plan is lenient', () => {
    expect(() => planInstall({ llm: { id: 'qwen3.5-4b' }, embedding: { path: '/e.gguf', context: 2048 } })).toThrow(/`model\.embedding\.pooling`/);
    const lenient = planInstall({ llm: { id: 'qwen3.5-4b' }, embedding: { path: '/e.gguf', context: 2048 } }, { lenient: true });
    expect(lenient.find((s) => s.id === 'embedding')).toMatchObject({ status: 'failed', note: expect.stringMatching(/`model\.embedding\.pooling`/) });
    // The block that says its pooling, or names a catalog id, plans.
    expect(planInstall({ llm: { id: 'qwen3.5-4b' }, embedding: { path: '/e.gguf', context: 2048, pooling: 'mean' } }).find((s) => s.id === 'embedding')).toMatchObject({ status: 'pending', spec: { path: '/e.gguf' } });
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
    // The row carries the whole refusal — the one thing a view has to show, since no remedy of its own applies.
    expect(sent[0].steps[0].note).toMatch(/^Qwen3.5 4B · Q4_K_M needs about 10 GB of memory and this machine has 8 GB\. Nothing was downloaded\./);
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

  it('a step that fails without any download ever expected — a path that is not there — still publishes its row (no view: ends; a view: holds)', async () => {
    // Nothing in this run fetches: the llm is a local path. It is missing.
    resolveModel.mockRejectedValueOnce(new Error('Model file not found: /weights/gone.gguf'));
    const sent: InstallStepEvent[] = [];
    await expect(run(() => install({ projectRoot: '/proj', model: { llm: { path: '/weights/gone.gguf' } }, totalBytes: 16 * GB, report: (ev) => sent.push(ev) })))
      .rejects.toThrow(/not found/);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.at(-1)!.steps[1]).toMatchObject({ status: 'failed', note: 'Model file not found: /weights/gone.gguf' });

    resolveModel.mockRejectedValueOnce(new Error('Model file not found: /weights/gone.gguf'));
    const held: InstallStepEvent[] = [];
    const controls = createSignal<InstallCommand, void>();
    const acquired = await run(function* () {
      const task = yield* spawn(() => install({
        projectRoot: '/proj', model: { llm: { path: '/weights/gone.gguf' } }, totalBytes: 16 * GB, report: (ev) => held.push(ev), controls,
        persist: (patch) => ({ llm: { path: (patch.model as { llm: { path: string } }).llm.path } }),
      }));
      yield* sleep(10);
      expect(held.at(-1)!.steps[1]).toMatchObject({ status: 'failed' });   // published, and holding
      controls.send({ type: 'install:use_file', step: 'llm', path: '/weights/here.gguf' });
      return yield* task;
    });
    expect(acquired.llm).toBe('/proj/models/llm//weights/here.gguf.gguf');
    expect(held.at(-1)!.steps).toEqual([]);
  });

  it('a file for the llm re-derives the projector: under a catalog id it stays; under the file it is refused, and the row says so and holds', async () => {
    resolveModel.mockImplementationOnce((o: Asked) => new Promise((_resolve, reject) => {
      asked.push(o);
      o.signal!.addEventListener('abort', () => reject(new DownloadStopped()));
    }));
    const sent: InstallStepEvent[] = [];
    const controls = createSignal<InstallCommand, void>();
    await run(function* () {
      const task = yield* spawn(() => install({
        projectRoot: '/proj', model: { llm: { id: 'qwen3.5-4b' }, vision: {} }, totalBytes: 16 * GB,
        report: (ev) => sent.push(ev), controls,
        persist: (patch) => ({ llm: { path: (patch.model as { llm: { path: string } }).llm.path }, vision: {} }),   // the id is gone: a file replaced it
      }));
      yield* sleep(10);
      controls.send({ type: 'install:use_file', step: 'llm', path: '/weights/mine.gguf' });
      yield* sleep(10);
      // The llm resolved from the file; the vision step, derived from an llm the catalog no longer knows, is refused by name — and holds.
      const rows = sent.at(-1)!.steps;
      expect(rows.find((r) => r.id === 'llm')).toMatchObject({ status: 'done' });
      expect(rows.find((r) => r.id === 'vision')).toMatchObject({ status: 'failed', note: expect.stringMatching(/none follows from the llm/) });
      expect(asked.map((a) => a.role)).toEqual(['llm', 'llm']);   // vision was never resolved: a stale slot must not be adopted
      controls.send({ type: 'install:quit' });
      yield* task.halt();
    });
  });

  it('a file for a step already done sends it back through the walk and replaces its artifact; a sibling whose spec is unchanged keeps its place', async () => {
    // llm done at once; the reranker's download parks until told.
    resolveModel.mockImplementationOnce(async (o: Asked) => { asked.push(o); return '/proj/models/llm/qwen3.5-4b.gguf'; });
    resolveModel.mockImplementationOnce((o: Asked) => new Promise((_resolve, reject) => { asked.push(o); o.signal!.addEventListener('abort', () => reject(new DownloadStopped())); }));
    const sent: InstallStepEvent[] = [];
    const controls = createSignal<InstallCommand, void>();
    const acquired = await run(function* () {
      const task = yield* spawn(() => install({
        projectRoot: '/proj', model: { llm: { id: 'qwen3.5-4b' }, reranker: { id: 'r', context: 16384 } }, totalBytes: 16 * GB,
        report: (ev) => sent.push(ev), controls,
        persist: (patch) => ({ llm: { id: 'qwen3.5-4b', path: (patch.model as { llm: { path: string } }).llm.path }, reranker: { id: 'r', context: 16384 } }),
      }));
      yield* sleep(10);
      expect(sent.at(-1)!.steps.map((s) => s.status)).toEqual(['done', 'done', 'running']);
      controls.send({ type: 'install:use_file', step: 'llm', path: '/weights/mine.gguf' });
      return yield* task;
    });
    // The walk went back to the llm and ran it from the file, then the reranker again from its unchanged spec.
    expect(asked.map((a) => [a.role, a.spec])).toEqual([['llm', { id: 'qwen3.5-4b' }], ['reranker', { id: 'r' }], ['llm', { path: '/weights/mine.gguf' }], ['reranker', { id: 'r' }]]);
    expect(acquired.llm).toBe('/proj/models/llm//weights/mine.gguf.gguf');
    expect(acquired.model.llm?.path).toBe('/weights/mine.gguf');
  });

  it('a file for a step not yet reached is its spec when its turn comes; nothing else moves', async () => {
    resolveModel.mockImplementationOnce((o: Asked) => new Promise((_resolve, reject) => { asked.push(o); o.signal!.addEventListener('abort', () => reject(new DownloadStopped())); }));
    const controls = createSignal<InstallCommand, void>();
    const acquired = await run(function* () {
      const task = yield* spawn(() => install({
        projectRoot: '/proj', model: { llm: { id: 'qwen3.5-4b' }, reranker: { id: 'r', context: 16384 } }, totalBytes: 16 * GB,
        report: () => {}, controls,
        persist: (patch) => ({ llm: { id: 'qwen3.5-4b' }, reranker: { id: 'r', path: (patch.model as { reranker: { path: string } }).reranker.path, context: 16384 } }),
      }));
      yield* sleep(10);
      controls.send({ type: 'install:use_file', step: 'reranker', path: '/weights/reranker.gguf' });
      return yield* task;
    });
    // The llm's download was interrupted by the command and re-run from its unchanged spec; the reranker resolved from the file.
    expect(asked.map((a) => [a.role, a.spec])).toEqual([['llm', { id: 'qwen3.5-4b' }], ['llm', { id: 'qwen3.5-4b' }], ['reranker', { path: '/weights/reranker.gguf' }]]);
    expect(acquired.services.reranker).toBe('/proj/models/reranker//weights/reranker.gguf.gguf');
  });

  it('a file for a step that cannot take one — no such step, the machine — is said in the held row, and the hold continues', async () => {
    resolveModel.mockRejectedValueOnce(new Error('offline'));
    const sent: InstallStepEvent[] = [];
    const controls = createSignal<InstallCommand, void>();
    const persist = vi.fn(() => ({}));
    const acquired = await run(function* () {
      const task = yield* spawn(() => install({ projectRoot: '/proj', model: { llm: { id: 'qwen3.5-4b' } }, totalBytes: 16 * GB, report: (ev) => sent.push(ev), controls, persist }));
      yield* sleep(10);
      controls.send({ type: 'install:use_file', step: 'nothing', path: '/weights/mine.gguf' });
      yield* sleep(10);
      expect(sent.at(-1)!.steps[1]).toMatchObject({ id: 'llm', status: 'failed', note: 'no step is called "nothing"' });
      controls.send({ type: 'install:use_file', step: 'machine', path: '/weights/mine.gguf' });
      yield* sleep(10);
      expect(sent.at(-1)!.steps[1]).toMatchObject({ id: 'llm', status: 'failed', note: '"This machine" does not take a file' });
      controls.send({ type: 'install:retry' });
      return yield* task;
    });
    expect(persist).not.toHaveBeenCalled();           // nothing from the wire reached the disk
    expect(acquired.llm).toBe('/proj/models/llm/qwen3.5-4b.gguf');
  });

  it('a file that cannot be remembered — the save fails — is that step\'s failure, and the hold continues where a view can act', async () => {
    resolveModel.mockRejectedValueOnce(new Error('offline'));
    const sent: InstallStepEvent[] = [];
    const controls = createSignal<InstallCommand, void>();
    const persist = vi.fn()
      .mockImplementationOnce(() => { throw new Error('EROFS: read-only file system'); })
      .mockImplementationOnce(() => ({ llm: { path: '/weights/mine.gguf' } }));
    const acquired = await run(function* () {
      const task = yield* spawn(() => install({ projectRoot: '/proj', model: { llm: { id: 'qwen3.5-4b' } }, totalBytes: 16 * GB, report: (ev) => sent.push(ev), controls, persist }));
      yield* sleep(10);
      controls.send({ type: 'install:use_file', step: 'llm', path: '/weights/mine.gguf' });
      yield* sleep(10);
      expect(sent.at(-1)!.steps[1]).toMatchObject({ status: 'failed', note: 'the file could not be remembered: EROFS: read-only file system' });
      controls.send({ type: 'install:use_file', step: 'llm', path: '/weights/mine.gguf' });
      return yield* task;
    });
    expect(acquired.llm).toBe('/proj/models/llm//weights/mine.gguf.gguf');
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
