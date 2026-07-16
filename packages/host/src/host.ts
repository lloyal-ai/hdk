/**
 * `ModelRuntimeHost` — the box-side host that turns ONE resident model into N
 * users: it admits Sessions (FIFO, capped),
 * materialises one `SessionContext` per admission over the shared model, and runs
 * N UNCHANGED harness scopes concurrently.
 *
 * Two planes, never conflated:
 *   · Admission — serialised by the pump (below). The doorman, not the dispatcher.
 *   · Execution — the N harness scopes, spawned as independent concurrent children;
 *     the pump never touches a running harness again. (A *third* plane — whether N
 *     same-model contexts may decode truly-concurrently on the GPU — is what the
 *     spike measures, backend-uniform; a native width ceiling hardens it later.
 *     Not this file's concern.)
 *
 * Built as an Effection `resource` that `spawn`s each harness as a structured
 * child, so halting the host unwinds every session — no captured scope, no manual
 * task management on top of the runtime.
 */
import { resource, spawn, action, call, ensure } from "effection";
import type { Operation } from "effection";
import type {
  AdmissionRequest,
  Materialised,
  ModelRuntimeHostOpts,
  NativeSessionRecord,
  SessionState,
} from "./types";

/** The handle a transport (or a driver) drives. Sync methods — callable from a
 *  plain `ws.on("connection")` callback; they feed the pump, never block it. */
export interface ModelRuntimeHost<Ctx = unknown> {
  /** Enqueue a Session for admission (FIFO). Emits `queued`, then the pump takes
   *  it to `warming`→`live` when a slot is free (or `died` if materialise fails).
   *  A `sessionId` that is already queued or live is refused (emits `died`) — the
   *  one-Session↔one-context invariant, so a duplicate never orphans a context. */
  admit(req: AdmissionRequest): void;
  /** Release a live Session: halt its harness scope (the context frees on unwind),
   *  which re-pumps the queue for the next waiting Session. No-op if unknown.
   *  Returns the halt promise — the transport may ignore it; a caller that wants
   *  to await the context actually freeing (e.g. a graceful drain) can. */
  release(sessionId: string): Promise<void>;
  /** Live Sessions. `sessions.size` IS the authoritative occupancy (no counter). */
  readonly sessions: ReadonlyMap<string, NativeSessionRecord<Ctx>>;
  readonly occupancy: number;
  readonly queueDepth: number;
  readonly maxNativeSessions: number;
}

/**
 * Create the host. It runs a single admission pump for its lifetime; when the
 * caller's scope unwinds, the resource tears down — halting the pump and every
 * session child with it.
 */
export function createModelRuntimeHost<Ctx = unknown>(
  opts: ModelRuntimeHostOpts<Ctx>,
): Operation<ModelRuntimeHost<Ctx>> {
  const { served, maxNativeSessions } = opts;

  return resource(function* (provide) {
    const queue: AdmissionRequest[] = [];
    const sessions = new Map<string, NativeSessionRecord<Ctx>>();

    // A caller-provided `onState` must never take down the pump or corrupt a
    // teardown — the "one bad callback can't sink all N sessions" boundary. Every
    // transition goes through here.
    const emit = (req: AdmissionRequest, state: SessionState): void => {
      try {
        req.onState?.(state);
      } catch {
        /* a broken observer is the observer's problem, not the host's */
      }
    };

    // Race-free wake latch. `admit` and `release` call `kick()` synchronously
    // (from any callback); the pump drains the queue, then suspends until the
    // next kick. `dirty` closes the window between "queue looks drained" and
    // "start waiting" — a plain `createSignal` pulse would be lost if it fired
    // before the pump subscribed, which is exactly what admission does.
    let dirty = false;
    let wakeWaiter: (() => void) | null = null;
    const kick = (): void => {
      dirty = true;
      wakeWaiter?.();
    };

    function* sessionOp(
      m: Materialised<Ctx>,
      req: AdmissionRequest,
    ): Operation<void> {
      // Teardown runs LIFO — register the slot-drop FIRST (runs last) and the
      // dispose SECOND (runs first): on unwind we dispose the context BEFORE
      // dropping the slot + re-pumping, so occupancy never understates resident
      // memory and the pump can't over-admit while a context is still freeing.
      yield* ensure(() => {
        sessions.delete(req.sessionId);
        emit(req, { phase: "reaped" });
        kick();
      });
      yield* ensure(() => {
        m.dispose();
      });
      try {
        yield* served.run(m, req.sessionId); // the UNCHANGED harness, concurrent
      } finally {
        emit(req, { phase: "draining" });
      }
    }

    // The admission pump. Sole mutator of `queue` + `sessions`; non-reentrant by
    // being one fiber. `materialise` is awaited here ⇒ context construction is
    // serialised (over its `await` is the only window an admission could race the
    // last free slot). The harnesses it spawns run fully concurrently.
    yield* spawn(function* (): Operation<void> {
      for (;;) {
        dirty = false;
        while (queue.length > 0 && sessions.size < maxNativeSessions) {
          const req = queue.shift()!;
          emit(req, { phase: "warming" });
          let m: Materialised<Ctx>;
          try {
            m = yield* call(() => served.materialise(req.sessionId));
          } catch {
            // Typed rejection for THIS request, not a dead pump. Nothing was
            // inserted, so there is nothing to roll back.
            emit(req, { phase: "died" });
            continue;
          }
          const task = yield* spawn(() => sessionOp(m, req));
          sessions.set(req.sessionId, {
            ...m,
            sessionId: req.sessionId,
            task,
            cancel: () => {
              void task.halt();
            },
          });
          emit(req, { phase: "live" });
        }
        if (dirty) continue; // a kick landed during the drain — re-drain
        yield* action<void>((resolve) => {
          wakeWaiter = resolve;
          if (dirty) resolve(); // kicked between the check above and here
          return () => {
            wakeWaiter = null;
          };
        });
      }
    });

    const host: ModelRuntimeHost<Ctx> = {
      admit(req) {
        // Refuse a duplicate: a `sessionId` already resident or waiting would,
        // once the pump ran, overwrite the live record and orphan its context.
        if (
          sessions.has(req.sessionId) ||
          queue.some((q) => q.sessionId === req.sessionId)
        ) {
          emit(req, { phase: "died" });
          return;
        }
        emit(req, { phase: "queued", position: queue.length });
        queue.push(req);
        kick();
      },
      release(sessionId) {
        const rec = sessions.get(sessionId);
        return rec ? rec.task.halt() : Promise.resolve();
      },
      get sessions() {
        return sessions;
      },
      get occupancy() {
        return sessions.size;
      },
      get queueDepth() {
        return queue.length;
      },
      maxNativeSessions,
    };
    yield* provide(host);
  });
}
