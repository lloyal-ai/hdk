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
  /** Framework words — "Getting the model". A view may relabel; rig never names the harness. */
  label: string;
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
 * because what has not started is in the list too. Empty when the install is over — and a
 * run that acquires nothing never sends one at all.
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

/** Whether a command is the install's — routed to it by the boot, never to the harness. */
export const isInstallCommand = (c: unknown): c is InstallCommand =>
  typeof c === 'object' && c !== null && typeof (c as { type?: unknown }).type === 'string' && (c as { type: string }).type.startsWith('install:');
