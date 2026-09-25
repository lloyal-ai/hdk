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
 * **It also owns the session's life, in the platform's own words.** A desktop
 * shell has a host in every sense that matters to a reader — something that
 * starts the harness, knows when it is usable and knows when it is gone — so it
 * reports {@link SessionState} rather than inventing a second vocabulary for
 * the same facts. `warming` at the fork, `live` at the child's own `ready`
 * (which means the command channel is attached, and is the earliest honest
 * boundary — a child exists while it is still loading a model), `draining`
 * once a stop is asked for, then `reaped` or `died`. The renderer's IPC link
 * stays up throughout, which is exactly why the session's state and the
 * transport's are two facts and not one.
 *
 * @category Desktop
 */
import { existsSync } from 'node:fs';
import { utilityProcess } from 'electron';
import type { Descriptor } from '@lloyal-labs/media';
import type { Frame, SessionState, Snapshot } from '@lloyal-labs/binding';

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

/** The install snapshot rig last sent, retained verbatim. Structural on purpose: this package names the shape it
 *  relays, never rig's type. */
export type InstallFrame = { type: 'install:step'; steps: readonly unknown[] };

export interface Engine<C, S> {
  /** Post a command to the engine. False when the engine is not running. */
  send(command: C): boolean;
  /** The shell's fold as of the last frame forwarded: the renderer's seed on (re)load. */
  snapshot(): Snapshot<S>;
  /** Hand bytes to the engine and wait for the root descriptor it commits. `signal` carries the deadline across. */
  ingest(bytes: Uint8Array, signal: AbortSignal): Promise<Descriptor>;
  /** Stop the engine. */
  kill(): void;
  /** This session's life, as the renderer's view reads it. */
  session(): SessionState;
  /** What is being acquired, as last reported — or null when this run acquires nothing, which is every run
   *  after the first. */
  install(): InstallFrame | null;
  /** Subscribe to it: the current state at once, then every change. Returns the unsubscribe. */
  onSession(cb: (state: SessionState) => void): () => void;
  /**
   * Replace the engine with a fresh one — the reader's way back from a session
   * that ended.
   *
   * The replacement is not forked until the old process has actually gone:
   * `draining` says work cannot be taken, never that the model has been freed.
   * Settles when the replacement is USABLE or has failed to start, and a request
   * made in the meantime reuses the one in flight — what the reader asked for is
   * a working harness, and between the fork and `ready` there is not one yet, so
   * a second press would otherwise kill an engine still loading its model.
   */
  restart(): Promise<void>;
  readonly running: boolean;
}

export function createEngine<E, C, S>(opts: CreateEngineOpts<E, S>): Engine<C, S> {
  const fork = opts.fork ?? forkUtilityProcess;
  let epoch = Date.now();
  let seq = 0;
  let state = opts.initialState;
  let child: EngineProcess | null = null;
  /** Which fork we own. A dead child's listeners stay attached to its own process object. */
  let generation = 0;
  let stopping = false;   // we asked it to go
  let replacing = false;  // …and something is taking its place, so its end is not the session's
  let awaitExit: (() => void) | null = null;
  /** Armed across a replacement's startup: settled when it is usable, or when it failed to start. */
  let awaitStartup: (() => void) | null = null;
  let restarting: Promise<void> | null = null;
  let session: SessionState = { phase: 'warming' };
  let install: InstallFrame | null = null;
  const sessionListeners = new Set<(state: SessionState) => void>();
  const pending = new Map<number, { resolve: (d: Descriptor) => void; reject: (e: Error) => void }>();
  let ingestId = 0;

  const announce = (next: SessionState): void => {
    session = next;
    // A startup is over at its first outcome, either way. `warming` is not one.
    if (next.phase === 'live' || next.phase === 'died') {
      const up = awaitStartup;
      awaitStartup = null;
      up?.();
    }
    for (const cb of sessionListeners) cb(next);
  };

  const post = (message: unknown): boolean => {
    if (!child) return false;
    try {
      child.postMessage(message);
      return true;
    } catch {
      return false;
    }
  };

  const failPending = (why: string): void => {
    for (const [, waiting] of pending) waiting.reject(new Error(why));
    pending.clear();
  };

  function start(): void {
    const mine = ++generation;
    stopping = false;
    replacing = false;
    announce({ phase: 'warming' });
    let proc: EngineProcess;
    try {
      proc = fork(opts.bin, { ...process.env, ...opts.env, RR_BRIDGE: '1' });
    } catch (err) {
      // A shell whose engine will not start must still open and say so; throwing here would take
      // the main process down before the window that could report it exists.
      child = null;
      opts.log?.('exit', err instanceof Error ? err.message : String(err));
      announce({ phase: 'died' });
      return;
    }
    child = proc;
    proc.stdout?.on('data', (d) => opts.log?.('stdout', d.toString().trimEnd()));
    proc.stderr?.on('data', (d) => opts.log?.('stderr', d.toString().trimEnd()));
    proc.on('message', (raw) => {
      if (mine !== generation) return;   // a child we no longer own, still talking
      const msg = raw as { t?: string; payload?: E; id?: number; root?: Descriptor; error?: string };
      if (msg?.t === 'ready') {
        // The command channel is attached. Not a promise that the harness has finished booting —
        // it is simply the first moment anything the reader does can reach it.
        announce({ phase: 'live' });
        return;
      }
      if (msg?.t === 'event' && msg.payload !== undefined) {
        seq += 1;
        state = opts.reduce(state, msg.payload);
        // Retained beside the fold, not inside it: acquiring weights is the platform's business, so no harness
        // declares it and none can drop it. A renderer that loads after the install finished — or after a
        // refusal ended the engine — asks for this rather than guessing, exactly as it does for the session.
        const ev = msg.payload as { type?: unknown };
        if (ev && ev.type === 'install:step') install = msg.payload as unknown as InstallFrame;
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
      if (mine !== generation) return;
      opts.log?.('exit', String(code));
      // Drop the handle FIRST: a stale one passes `if (!child)`, and a message to a dead process is discarded
      // silently. An ingest in flight must FAIL, not hang.
      child = null;
      failPending('the engine stopped before the file was ingested');
      const wake = awaitExit;
      awaitExit = null;
      // A replacement is coming: the reader is between engines, not without one, so nothing terminal
      // is said and the banner does not flash "ended" on the way to a working session.
      if (replacing) return wake?.();
      announce(stopping ? { phase: 'reaped' } : { phase: 'died', ...(code != null ? { code } : {}) });
      wake?.();
    });
  }

  start();

  return {
    send: (command) => post({ t: 'command', payload: command }),
    snapshot: () => ({ state, epoch, seq }),
    session: () => session,
    install: () => install,
    onSession(cb) {
      sessionListeners.add(cb);
      cb(session);   // a renderer that loads mid-session is told where things stand
      return () => { sessionListeners.delete(cb); };
    },
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
      if (!child) return;
      stopping = true;
      announce({ phase: 'draining' });
      try { child.kill(); } catch { /* already gone; its exit still arrives */ }
    },
    restart() {
      if (restarting) return restarting;   // the reader pressed it twice; one engine, one promise
      const done = (async () => {
        if (child) {
          stopping = true;
          replacing = true;
          announce({ phase: 'draining' });
          const gone = new Promise<void>((resolve) => { awaitExit = resolve; });
          try { child.kill(); } catch { /* already gone; its exit still arrives */ }
          await gone;   // the model is resident until the process is gone: never two at once
        }
        // A fresh stream. The renderer compares frames only within an epoch, so the replacement
        // must not reuse one — `Date.now()` alone can repeat inside a millisecond.
        epoch = Math.max(Date.now(), epoch + 1);
        seq = 0;
        state = opts.initialState;
        install = null;
        // Stay in flight until the replacement is usable or has failed, so a reader who presses
        // again a moment later REUSES this one. Clearing at the fork would let the second press
        // kill an engine that is still loading its model, throwing away the wait and starting it
        // over — and the second press is exactly what an unresponsive-looking startup invites.
        // It ends at `died` too, so a startup that failed leaves recovery available again.
        const up = new Promise<void>((resolve) => { awaitStartup = resolve; });
        start();
        await up;
      })();
      restarting = done;
      void done.finally(() => { if (restarting === done) restarting = null; });
      return done;
    },
    get running() {
      return child !== null;
    },
  };
}
