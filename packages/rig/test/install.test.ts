/**
 * Tests for the install act: the machine gate ({@link checkMachine}), what a
 * refusal says ({@link refusalMessage}), and the step list a view draws
 * ({@link planSteps} / {@link installReporter}).
 *
 * Behaviours verified:
 *  1. A box under its class floor is refused; one at or over it passes.
 *  2. Every catalog llm names a class, and each class's floor holds its model's
 *     weights with real headroom — the guard that a new row cannot be added
 *     without saying which machines can run it.
 *  3. A model with no class (a `path:` override) is not gated at all.
 *  4. The refusal states found-vs-needed, says nothing was downloaded, and —
 *     at the edge floor — offers no smaller model, because there is none.
 *  5. The reporter emits a whole snapshot per change, so a view holds no state
 *     machine and can draw pending rows.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import {
  checkMachine,
  gb,
  installReporter,
  mockInstallFrames,
  planSteps,
  refusalMessage,
  rerankerStep,
} from '../src/install';
import type { InstallStepEvent } from '../src/install';
import { MACHINE_CLASS_FLOOR_BYTES, MODEL_CATALOG, catalogEntry } from '../src/models';
import { declaredServices } from '../src/provision';
import { SERVICES } from '@lloyal-labs/lloyal-agents';

const GB = 1024 ** 3;

describe('checkMachine', () => {
  it('refuses a box under the class floor and passes one at it', () => {
    const edge = { machineClass: 'edge' as const };
    // The 8 GB Air this gate exists for.
    const small = checkMachine(edge, 8 * GB);
    expect(small?.ok).toBe(false);
    expect(small?.totalBytes).toBe(8 * GB);
    expect(small?.neededBytes).toBe(MACHINE_CLASS_FLOOR_BYTES.edge);

    // Exactly the floor passes: the floor is a minimum, not a threshold to clear.
    expect(checkMachine(edge, MACHINE_CLASS_FLOOR_BYTES.edge)?.ok).toBe(true);
    expect(checkMachine(edge, 16 * GB)?.ok).toBe(true);
  });

  it('holds the class boundary: 24 GB is an appliance, not a big edge box', () => {
    const appliance = { machineClass: 'appliance' as const };
    // A 16 GB laptop runs the edge model and must NOT be offered the 27B.
    expect(checkMachine(appliance, 16 * GB)?.ok).toBe(false);
    expect(checkMachine(appliance, 24 * GB)?.ok).toBe(true);
    // Appliance starts where edge tops out.
    expect(MACHINE_CLASS_FLOOR_BYTES.appliance).toBe(24 * GB);
    expect(MACHINE_CLASS_FLOOR_BYTES.edge).toBe(10 * GB);
  });

  it('does not gate a model that names no class — trusted by possession', () => {
    expect(checkMachine({}, 1 * GB)).toBeNull();
  });
});

describe('the catalog declares what each model needs', () => {
  it('every llm names a machine class', () => {
    const llms = MODEL_CATALOG.filter((m) => m.role === 'llm');
    expect(llms.length).toBeGreaterThan(0);
    for (const m of llms) {
      expect(m.machineClass, `catalog llm "${m.id}" names no machineClass`).toBeDefined();
    }
  });

  it('a projector and a reranker name none — they ride their llm', () => {
    for (const m of MODEL_CATALOG.filter((m) => m.role !== 'llm')) {
      expect(m.machineClass, `"${m.id}" (role ${m.role}) should not be gated`).toBeUndefined();
    }
  });

  it("each class's floor clears its model's weights with headroom for KV", () => {
    // Not a formula — the floors are declared. This asserts they are at least
    // coherent: a floor below the weights it must hold would be a typo that
    // passes every other test.
    for (const m of MODEL_CATALOG.filter((m) => m.role === 'llm' && m.machineClass)) {
      const floor = MACHINE_CLASS_FLOOR_BYTES[m.machineClass!];
      const projector = m.mmproj ? (catalogEntry('mmproj', m.mmproj)?.sizeBytes ?? 0) : 0;
      expect(floor, `${m.id}: floor ${gb(floor)} under its own weights`).toBeGreaterThan(
        m.sizeBytes + projector,
      );
    }
  });
});

describe('refusalMessage', () => {
  const verdict = checkMachine({ machineClass: 'edge' }, 8 * GB)!;

  it('states found vs needed, and that nothing was spent', () => {
    const msg = refusalMessage(verdict, 'Qwen3.5 4B · Q4_K_M');
    expect(msg).toContain('8 GB');
    expect(msg).toContain('10 GB');
    expect(msg).toContain('Nothing was downloaded');
  });

  it('offers no smaller model at the edge floor, because there is none', () => {
    const msg = refusalMessage(verdict, 'Qwen3.5 4B · Q4_K_M');
    expect(msg).toMatch(/no smaller model/i);
    // The smallest llm in the catalog IS an edge model, so the claim holds.
    const smallest = [...MODEL_CATALOG.filter((m) => m.role === 'llm')].sort(
      (a, b) => a.sizeBytes - b.sizeBytes,
    )[0];
    expect(smallest.machineClass).toBe('edge');
  });

  it('an appliance model on a small box is pointed at the edge tier instead', () => {
    const v = checkMachine({ machineClass: 'appliance' }, 16 * GB)!;
    const msg = refusalMessage(v, 'Qwen3.8 27B · Q4_K_M');
    expect(msg).toMatch(/edge-class/i);
    expect(msg).not.toMatch(/no smaller model/i);
  });
});

describe('the reporter', () => {
  it('sends the WHOLE list each time, so pending rows can be drawn', () => {
    const sent: InstallStepEvent[] = [];
    const steps = planSteps({ projector: true });
    const report = installReporter((ev) => sent.push(ev), steps);

    report.announce();
    expect(sent).toHaveLength(1);
    expect(sent[0].steps.map((s) => s.id)).toEqual(['machine', 'model', 'projector']);
    expect(sent[0].steps.every((s) => s.status === 'pending')).toBe(true);

    report.set('model', { status: 'running', got: 100, total: 400 });
    // Still the whole list — the two untouched rows included.
    expect(sent[1].steps).toHaveLength(3);
    expect(sent[1].steps.find((s) => s.id === 'model')).toMatchObject({
      status: 'running', got: 100, total: 400,
    });
    expect(sent[1].steps.find((s) => s.id === 'projector')?.status).toBe('pending');
  });

  it('snapshots are copies — a later mutation cannot rewrite a sent frame', () => {
    const sent: InstallStepEvent[] = [];
    const report = installReporter((ev) => sent.push(ev), planSteps({ projector: false }));
    report.set('model', { status: 'running', got: 1, total: 2 });
    report.set('model', { status: 'done' });
    expect(sent[0].steps.find((s) => s.id === 'model')?.status).toBe('running');
    expect(sent[1].steps.find((s) => s.id === 'model')?.status).toBe('done');
  });

  it('omits a projector row when the model has no vision', () => {
    expect(planSteps({ projector: false }).map((s) => s.id)).toEqual(['machine', 'model']);
  });

  it('appends the reranker only once, when it turns out to be needed', () => {
    const sent: InstallStepEvent[] = [];
    const report = installReporter((ev) => sent.push(ev), planSteps({ projector: false }));
    report.add(rerankerStep());
    report.add(rerankerStep());
    expect(sent).toHaveLength(1);
    expect(sent[0].steps.map((s) => s.id)).toEqual(['machine', 'model', 'reranker']);
  });
});

describe('the install ends', () => {
  it('clears to an EMPTY list, so a finished screen does not sit in front of the app', () => {
    // The view shows the installer while there are steps. Leaving them at
    // `done` held a completed installer over a running app — found by writing
    // the mock, not by reading the code.
    const sent: InstallStepEvent[] = [];
    const report = installReporter((ev) => sent.push(ev), planSteps({ projector: false }));
    report.set('model', { status: 'done' });
    report.clear();
    expect(sent[sent.length - 1].steps).toEqual([]);
  });

  it('a run that acquires nothing and one that finished report the SAME thing', () => {
    // One state means "there is no install here", however it came to be true —
    // so a view needs no rule for telling the two apart.
    const never: InstallStepEvent[] = [];
    installReporter((ev) => never.push(ev), []).announce();
    const done: InstallStepEvent[] = [];
    const report = installReporter((ev) => done.push(ev), planSteps({ projector: true }));
    report.clear();
    expect(done[done.length - 1].steps).toEqual(never[never.length - 1].steps);
  });
});

describe('mockInstallFrames', () => {
  const steps = planSteps({ projector: true });
  const sizeOf = (id: string): number => (id === 'projector' ? 672_423_616 : 2_600_000_000);

  it('walks every download step to its real total, and skips the machine check', () => {
    const frames = mockInstallFrames(steps, sizeOf as never, 4);
    expect(new Set(frames.map((f) => f.id))).toEqual(new Set(['model', 'projector']));
    for (const id of ['model', 'projector'] as const) {
      const last = [...frames].reverse().find((f) => f.id === id)!;
      expect(last.got).toBe(sizeOf(id));      // ends exactly at the real size
      expect(last.total).toBe(sizeOf(id));
    }
  });

  it('spends wall-clock in proportion to bytes, so the big file feels big', () => {
    const frames = mockInstallFrames(steps, sizeOf as never, 10);
    const spent = (id: string): number =>
      frames.filter((f) => f.id === id).reduce((ms, f) => ms + f.afterMs, 0);
    const ratio = spent('model') / spent('projector');
    expect(ratio).toBeCloseTo(2_600_000_000 / 672_423_616, 1);
    expect(spent('model') + spent('projector')).toBeCloseTo(10_000, 0);
  });

  it('a plan with nothing to download has nothing to replay', () => {
    expect(mockInstallFrames([{ id: 'machine', label: 'This machine', status: 'done' }], sizeOf as never, 5)).toEqual([]);
  });
});

describe('an auxiliary model is fetched because a consumer DECLARED it', () => {
  // ONE rule, both kinds of consumer, every auxiliary service. The reranker
  // already worked this way; vision did not — it rode the model's catalog
  // pairing, so a harness that could not send an image still fetched 672 MB for
  // one. Two derivation rules is one more than a reader should hold.
  const ability = (services: readonly string[]) =>
    ({ manifest: { services } }) as never;

  it('nothing declared → nothing wanted', () => {
    expect(declaredServices([], undefined).size).toBe(0);
    // wikipedia declares no services at all — basic's case exactly.
    expect(declaredServices([ability([])], undefined).size).toBe(0);
  });

  it("an ability's manifest declares", () => {
    const wants = declaredServices([ability(['reranker', 'vision'])], undefined);
    expect(wants.has('reranker')).toBe(true);
    expect(wants.has('vision')).toBe(true);
  });

  it('a HARNESS declares too — it is a consumer, with no ability involved', () => {
    // research prefills bitmaps straight to the model (`prefillUserMultimodal`),
    // so it consumes vision itself. And a harness may want a reranker for its
    // own code: `RerankerCtx` is exported and set in the scope the harness runs
    // in, so the restriction to abilities was arbitrary.
    expect(declaredServices([], ['vision']).has('vision')).toBe(true);
    expect(declaredServices([], ['reranker']).has('reranker')).toBe(true);
  });

  it('the two sources union, and a service declared twice is wanted once', () => {
    const wants = declaredServices([ability(['reranker'])], ['reranker', 'vision']);
    expect([...wants].sort()).toEqual(['reranker', 'vision']);
  });

  it('vision is a declarable service, beside the reranker', () => {
    // If this fails, `defineAbility` will reject a manifest that asks for it.
    expect(SERVICES).toContain('vision');
    expect(SERVICES).toContain('reranker');
  });
});
