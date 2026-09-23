/**
 * Acquiring what a harness needs before it can run: the machine check and the
 * weights fetch, reported step by step.
 *
 * INSTALL IS NOT BOOT. Install acquires bytes a machine does not have yet, so
 * it happens on a first run and then never again. Boot loads bytes already on
 * disk, and happens every start. They are separate screens because they are
 * separate events: a step list with a progress bar is honest for a download of
 * minutes and pure ceremony for a load of seconds.
 *
 * Nothing here is product vocabulary: a step says `model` or `projector`, never
 * what the harness does with them.
 *
 * @category Runtime
 */
import type { MachineClass, ModelCatalogEntry } from './models';
import { MACHINE_CLASS_FLOOR_BYTES } from './models';

/** What an install does, in the order it does it. A run performs the steps it
 *  needs: a text-only model has no `projector`, a harness whose abilities want
 *  no service has no `reranker`. */
export type InstallStepId = 'machine' | 'model' | 'projector' | 'reranker';

export interface InstallStep {
  id: InstallStepId;
  /** Framework words. A view may relabel; rig never names the harness. */
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  /** Bytes so far and expected, while a download runs. Absent on a step that
   *  moves no bytes, and on one that has not started. */
  got?: number;
  total?: number;
  /** What this step found, for the row's right rail: the machine's verdict,
   *  the model's name. Absent when there is nothing true to say. */
  note?: string;
}

/**
 * The install as it now stands — every step, each time.
 *
 * A snapshot rather than a delta so a view holds no state machine: the fold is
 * `steps = ev.steps`, and pending rows can be drawn because what has not
 * started is in the list too. The array is three or four entries; sending it
 * per progress tick costs nothing worth saving.
 *
 * Declared beside its producer so a node-free protocol can name it type-only,
 * the way {@link HostResourcesEvent} is.
 */
export interface InstallStepEvent {
  type: 'install:step';
  steps: readonly InstallStep[];
}

/** What the machine check decided, in the terms the refusal has to state. */
export interface MachineVerdict {
  ok: boolean;
  machineClass: MachineClass;
  /** What this box has. */
  totalBytes: number;
  /** What the class floor asks for. */
  neededBytes: number;
}

const GB = 1024 ** 3;
/** One decimal, as a reader says it: "8 GB", "15.7 GB". */
export const gb = (bytes: number): string =>
  `${(bytes / GB).toFixed(bytes % GB === 0 ? 0 : 1)} GB`;

/**
 * Can this machine hold this model?
 *
 * TOTAL memory, not free. The classes are stated as machine capacity — "laptops
 * 10–24 GB" — so total is the quantity they are about, and it is the only one
 * every platform answers honestly: `host-resources.ts`'s used-memory accounting
 * is darwin/linux only and returns nothing elsewhere by design. Gating on free
 * memory would also refuse a capable machine for having a browser open.
 *
 * An entry with no `machineClass` (a projector, a reranker, a hand-written row)
 * is not gated: it rides the llm that named one.
 *
 * `totalBytes` is passed in rather than read here, so this module names no Node
 * module and can sit in rig's platform-agnostic barrel beside the types a view
 * needs — and so a test states the machine instead of mocking one.
 */
export function checkMachine(
  entry: Pick<ModelCatalogEntry, 'machineClass'>,
  totalBytes: number,
): MachineVerdict | null {
  const machineClass = entry.machineClass;
  if (!machineClass) return null;
  const neededBytes = MACHINE_CLASS_FLOOR_BYTES[machineClass];
  return { ok: totalBytes >= neededBytes, machineClass, totalBytes, neededBytes };
}

/**
 * Why a machine was refused, and what can actually be done about it.
 *
 * No "use a smaller model": the smallest model in the catalog is the one the
 * edge class is built around, so under that floor there is nothing to fall back
 * to. Saying so plainly beats offering a route that does not exist.
 */
export function refusalMessage(v: MachineVerdict, label: string): string {
  return (
    `${label} needs about ${gb(v.neededBytes)} of memory and this machine has ${gb(v.totalBytes)}. ` +
    `Nothing was downloaded.\n` +
    (v.machineClass === 'edge'
      ? `That is below the minimum lloyal runs on, so there is no smaller model to fall back to. ` +
        `Close what you can spare and try again, or run this harness on a larger machine.`
      : `Choose an edge-class model for this machine, or run this harness on an appliance ` +
        `(${gb(MACHINE_CLASS_FLOOR_BYTES.appliance)} or more).`)
  );
}

/**
 * The steps this run will perform, as a list a view can draw at once — pending
 * rows included, which is what lets it show where the install is going rather
 * than only where it is.
 */
export function planSteps(opts: { projector: boolean }): InstallStep[] {
  const steps: InstallStep[] = [
    { id: 'machine', label: 'This machine', status: 'pending' },
    { id: 'model', label: 'Getting the model', status: 'pending' },
  ];
  if (opts.projector) steps.push({ id: 'projector', label: 'Getting the vision projector', status: 'pending' });
  return steps;
}

/**
 * A mock install: the same steps, the same real sizes, over a chosen number of
 * seconds — so the screen can be seen and smoke-tested without moving 2.6 GB.
 *
 * It fakes the REPORTING, never the download. `resolveModel` and `fetchVerified`
 * are untouched and simply are not invoked, because this runs only when the
 * weights are already on disk. There is no second acquisition path to drift from
 * the real one — there is no second path at all.
 *
 * Pure: it returns the frames, and the caller supplies the waiting. `ticks` is
 * per step, so a view sees progress move often enough to exercise rate and
 * time-left rather than jumping from nothing to done.
 */
export function mockInstallFrames(
  steps: readonly InstallStep[],
  sizeOf: (id: InstallStepId) => number,
  seconds: number,
  ticks = 40,
): { id: InstallStepId; got: number; total: number; afterMs: number }[] {
  const downloads = steps.filter((s) => s.id !== 'machine');
  if (downloads.length === 0) return [];
  const totalBytes = downloads.reduce((n, s) => n + sizeOf(s.id), 0) || 1;
  const frames: { id: InstallStepId; got: number; total: number; afterMs: number }[] = [];
  for (const step of downloads) {
    const total = sizeOf(step.id);
    // Each step's share of the wall clock is its share of the bytes, so a big
    // model and a small projector take time in the proportion they really would.
    const stepMs = (seconds * 1000 * total) / totalBytes;
    for (let i = 1; i <= ticks; i += 1) {
      frames.push({
        id: step.id,
        got: Math.round((total * i) / ticks),
        total,
        afterMs: stepMs / ticks,
      });
    }
  }
  return frames;
}

/** The reranker is NOT planned up front: whether a harness needs one is its
 *  abilities' to declare, and that is answered while they are provisioned. A
 *  row invented before the answer would sit pending forever on a harness that
 *  wants none — so it is added the moment its first byte arrives. */
export const rerankerStep = (): InstallStep => ({
  id: 'reranker',
  label: 'Getting the reranker',
  status: 'pending',
});

/**
 * A step list that reports itself: mutate through `set`, and every change is
 * sent as a whole snapshot.
 *
 * The emitter is handed in rather than the bus, so this stays free of the
 * harness's event type — rig injects its own events into an app's channel by
 * cast at the call site, as it does for the host sampler and the trace writer.
 */
export function installReporter(emit: (ev: InstallStepEvent) => void, steps: InstallStep[]) {
  const send = (): void => emit({ type: 'install:step', steps: steps.map((s) => ({ ...s })) });
  return {
    /** Every step, as they now stand — for a first paint before anything runs. */
    announce: send,
    /** A step this run turned out to need. Appended, never reordered. */
    add(step: InstallStep): void {
      if (steps.some((s) => s.id === step.id)) return;
      steps.push(step);
      send();
    },
    set(id: InstallStepId, patch: Partial<Omit<InstallStep, 'id' | 'label'>>): void {
      const step = steps.find((s) => s.id === id);
      if (!step) return;
      Object.assign(step, patch);
      send();
    },
    /**
     * Acquiring is over — say so with an EMPTY list.
     *
     * A view shows the installer while there are steps, so steps left standing
     * at `done` would hold a finished screen in front of a running app. Empty is
     * also what a run that acquired nothing reports, which is the point: one
     * state means "there is no install here", however it came to be true.
     */
    clear(): void {
      steps.length = 0;
      send();
    },
  };
}
