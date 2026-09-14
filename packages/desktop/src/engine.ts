/**
 * The engine: the project's own cli bin, forked as an Electron utility process
 * with the `ipc` binding mounted, and the shell's fold over what it says.
 *
 * Streaming model, the same as every target: the engine emits raw events; the
 * shell numbers each one (`seq` within this engine's `epoch`) and forwards the
 * frame to the renderer, which folds it through the SAME pure reduce — only
 * the small event crosses IPC, never the growing transcript. The shell also
 * folds every event itself, purely to answer ONE snapshot per (re)load: the
 * renderer seeds from it and applies only frames after the cut. An engine
 * respawn is a new epoch, so a renderer that outlives one cannot mix two.
 *
 * The shell relays uploads to the engine and waits for the root descriptor it
 * commits: the engine is the store's single writer.
 *
 * @category Desktop
 */
import { existsSync } from 'node:fs';
import { utilityProcess } from 'electron';
import type { Descriptor } from '@lloyal-labs/media';
import type { Frame, Snapshot } from '@lloyal-labs/binding';

/** The slice of Electron's `UtilityProcess` the engine uses, structurally — a test hands in a fake. */
export interface EngineProcess {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  kill(): boolean;
  stdout?: { on(event: 'data', listener: (chunk: { toString(): string }) => void): unknown } | null;
  stderr?: { on(event: 'data', listener: (chunk: { toString(): string }) => void): unknown } | null;
}

export interface CreateEngineOpts<E, S> {
  /** The engine binary — this project's own built cli boot, e.g. `join(process.cwd(), 'bin', 'run.js')`. */
  bin: string;
  /** Added to the engine's environment. `RR_BRIDGE` is set for you: it is what makes the cli boot mount the ipc binding. */
  env?: Record<string, string>;
  initialState: S;
  reduce: (state: S, ev: E) => S;
  /** Where a frame goes: the renderer, when its window is alive. */
  forward: (frame: Frame<E>) => void;
  /** The engine's own stdout/stderr lines. */
  log?: (stream: 'stdout' | 'stderr' | 'exit', text: string) => void;
  /** Fork it yourself. The default forks `bin` as an Electron utility process; a test hands in a fake. */
  fork?: (bin: string, env: NodeJS.ProcessEnv) => EngineProcess;
}

/** The default: this project's cli boot as a utility process, with the bridge flag set and its output piped. */
function forkUtilityProcess(bin: string, env: NodeJS.ProcessEnv): EngineProcess {
  // A missing binary is the one failure worth naming: the window would otherwise open onto an engine that never speaks.
  if (!existsSync(bin)) throw new Error(`engine not built: ${bin} not found — build the cli target first.`);
  return utilityProcess.fork(bin, [], { serviceName: 'harness-engine', stdio: 'pipe', env }) as unknown as EngineProcess;
}

export interface Engine<C, S> {
  /** Post a command to the engine. False when the engine is not running. */
  send(command: C): boolean;
  /** The shell's fold as of the last frame forwarded: the renderer's seed on (re)load. */
  snapshot(): Snapshot<S>;
  /** Hand bytes to the engine and wait for the root descriptor it commits. `signal` carries the deadline across. */
  ingest(bytes: Uint8Array, signal: AbortSignal): Promise<Descriptor>;
  /** Stop the engine. */
  kill(): void;
  readonly running: boolean;
}

export function createEngine<E, C, S>(opts: CreateEngineOpts<E, S>): Engine<C, S> {
  const epoch = Date.now();
  let seq = 0;
  let state = opts.initialState;
  let child: EngineProcess | null = null;
  const pending = new Map<number, { resolve: (d: Descriptor) => void; reject: (e: Error) => void }>();
  let ingestId = 0;

  const post = (message: unknown): boolean => {
    if (!child) return false;
    try {
      child.postMessage(message);
      return true;
    } catch {
      return false;
    }
  };

  const proc = (opts.fork ?? forkUtilityProcess)(opts.bin, { ...process.env, ...opts.env, RR_BRIDGE: '1' });
  child = proc;
  proc.stdout?.on('data', (d) => opts.log?.('stdout', d.toString().trimEnd()));
  proc.stderr?.on('data', (d) => opts.log?.('stderr', d.toString().trimEnd()));
  proc.on('message', (raw) => {
    const msg = raw as { t?: string; payload?: E; id?: number; root?: Descriptor; error?: string };
    if (msg?.t === 'event' && msg.payload !== undefined) {
      seq += 1;
      state = opts.reduce(state, msg.payload);
      opts.forward({ epoch, seq, ev: msg.payload });
      return;
    }
    if (typeof msg?.id !== 'number') return;
    const waiting = pending.get(msg.id);
    if (!waiting) return;
    pending.delete(msg.id);
    if (msg.t === 'ingested' && msg.root) waiting.resolve(msg.root);
    else if (msg.t === 'ingestFailed') waiting.reject(new Error(msg.error ?? 'ingest failed'));
  });
  proc.on('exit', (code) => {
    opts.log?.('exit', String(code));
    // Drop the handle FIRST: a stale one passes `if (!child)`, and a message to a dead process is discarded
    // silently. An ingest in flight must FAIL, not hang.
    child = null;
    for (const [, waiting] of pending) waiting.reject(new Error('the engine stopped before the file was ingested'));
    pending.clear();
  });

  return {
    send: (command) => post({ t: 'command', payload: command }),
    snapshot: () => ({ state, epoch, seq }),
    ingest(bytes, signal) {
      // An already-aborted signal fires no `abort` event, so the entry would sit in `pending` for the life of the process.
      if (signal.aborted) return Promise.reject(new Error('the ingest was cancelled'));
      if (!child) return Promise.reject(new Error('the engine is not running'));
      const id = ++ingestId;
      const answer = new Promise<Descriptor>((resolve, reject) => pending.set(id, { resolve, reject }));
      const settle = (fail: Error): void => {
        const waiting = pending.get(id);
        if (!waiting) return;
        pending.delete(id);
        waiting.reject(fail);
      };
      signal.addEventListener('abort', () => {
        post({ t: 'ingestCancel', id });
        settle(new Error('the ingest was cancelled'));
      }, { once: true });
      if (!post({ t: 'ingest', id, bytes })) settle(new Error('the engine is not running'));
      return answer;
    },
    kill() {
      child?.kill();
    },
    get running() {
      return child !== null;
    },
  };
}
