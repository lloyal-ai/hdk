/**
 * The install on the wire: what a run is acquiring before it can work, and what a reader
 * can do about a step that failed. Rig's vocabulary, like `host:resources` — injected into a
 * harness's channel by the boot, declared by no harness, read by the view the platform ships.
 * Node-free.
 *
 * @category Rig
 */

/** One step of the install, as a view draws it. */
export interface InstallStep {
  /** The step's name: `machine`, `llm`, `vision`, or a service's. */
  id: string;
  /** Framework words — "Downloading the reasoning model". A view may relabel; rig never names the harness. */
  label: string;
  /** The model this step acquires, as the catalog names it — or the file's own name for a `path`. Absent on a
   *  step that acquires no model (the machine) and on a block that selects nothing. */
  model?: string;
  /** Where it goes, relative to the project — `models/llm/qwen3.5-4b.gguf` — or the file's own path. */
  slot?: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  /** Bytes so far and expected, while a download runs. Absent on a step that moves no bytes,
   *  and on one that has not started. */
  got?: number;
  total?: number;
  /** What this step found, for the row's right rail: the machine's verdict, the model's name,
   *  why it failed. Absent when there is nothing true to say. */
  note?: string;
  /** Whether a file already on this machine may stand in for this step's download — true for
   *  a step whose block takes a `path`. */
  file?: boolean;
}

/**
 * The install as it now stands — every step, each time. A snapshot rather than a delta so a
 * view holds no state machine: the fold is `steps = ev.steps`, and pending rows can be drawn
 * because what has not started is in the list too. Empty when the install is over — the one
 * snapshot every run sends, so a run that acquires nothing still says so.
 */
export interface InstallStepEvent {
  type: 'install:step';
  steps: readonly InstallStep[];
}

/** What a reader can do about the install: run the failed step again, satisfy a step with a
 *  file already on this machine, or stop. */
export type InstallCommand =
  | { type: 'install:retry' }
  | { type: 'install:use_file'; step: string; path: string }
  | { type: 'install:quit' };

/** Whether a command is one of the install's three, whole — routed to the install by the boot, never to the
 *  harness. Anything else that says `install:` is a view wired to something the install never offered, and
 *  reaches the harness as the unknown command it is. */
export const isInstallCommand = (c: unknown): c is InstallCommand => {
  if (typeof c !== 'object' || c === null) return false;
  const { type, step, path } = c as { type?: unknown; step?: unknown; path?: unknown };
  if (type === 'install:retry' || type === 'install:quit') return true;
  return type === 'install:use_file' && typeof step === 'string' && typeof path === 'string';
};
