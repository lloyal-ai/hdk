/**
 * Can this machine hold this model? The gate a boot runs before a byte is fetched — and on
 * every start, since weights carried onto a box too small to hold them fail as hard as ones
 * downloaded onto it.
 *
 * TOTAL memory, not free. The classes are stated as machine capacity — "laptops 10–24 GB" —
 * so total is the quantity they are about, and the only one every platform answers honestly.
 * Gating on free memory would refuse a capable machine for having a browser open. It is passed
 * in rather than read here, so this module names no Node module and a test states the machine
 * instead of mocking one.
 *
 * @category Runtime
 */

/** The size of machine a model is for. One application runs on all of them; this says which
 *  boxes can hold which weights, so a picker offers what the machine can run and a boot refuses
 *  what it cannot. */
export type MachineClass = 'edge' | 'appliance';

/**
 * Each class's MINIMUM memory, not its typical size — an appliance starts where edge tops out,
 * and a 64 GB box is a roomy appliance, not the entry point.
 *
 * Declared, never derived: the headroom a model needs beyond its weights is KV, context and
 * runtime, and these figures are what the machines were observed to need. A new catalog row
 * states its class and inherits them.
 */
export const MACHINE_CLASS_FLOOR_BYTES: Readonly<Record<MachineClass, number>> = {
  edge: 10 * 1024 ** 3,
  appliance: 24 * 1024 ** 3,
};

/** What the gate decided, in the terms the refusal has to state. */
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
export const gb = (bytes: number): string => `${(bytes / GB).toFixed(bytes % GB === 0 ? 0 : 1)} GB`;

/** The verdict for a catalog entry, or null for one that names no class — a `path:` override, a
 *  projector, a reranker — which rides the llm and is not gated. */
export function checkMachine(entry: { machineClass?: MachineClass }, totalBytes: number): MachineVerdict | null {
  const machineClass = entry.machineClass;
  if (!machineClass) return null;
  const neededBytes = MACHINE_CLASS_FLOOR_BYTES[machineClass];
  return { ok: totalBytes >= neededBytes, machineClass, totalBytes, neededBytes };
}

/**
 * Why a machine was refused, and what can actually be done about it. No "use a smaller model"
 * under the edge floor: the smallest model in the catalog is the one that class is built around,
 * so there is nothing to fall back to, and saying so plainly beats offering a route that does not
 * exist.
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
