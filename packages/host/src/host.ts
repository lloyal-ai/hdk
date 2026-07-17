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
   *  A `sessionId` that is already queued, warming, or live is refused (emits
   *  `died`) — the one-Session↔one-context invariant, so a duplicate never orphans
   *  a context (including one mid-`warming`, whose materialise is still in flight). */
  admit(req: AdmissionRequest): void;
  /** Release a Session at ANY phase — the transport calls this on disconnect:
   *  `live` halts its harness scope (context frees on unwind, then re-pump);
   *  `queued` is dropped from the queue (never materialises); `warming` is flagged
   *  so the pump discards the just-built context rather than spawn a consumer-less
   *  harness. No-op if unknown. Returns the halt promise for a `live` release (an
   *  awaitable teardown a graceful drain can wait on); resolves immediately for
   *  `queued`/`warming` (whose disposal, if any, the pump completes). */
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
    // Every id from `admit` until final teardown — the dedup gate spanning
    // queued ∪ warming ∪ live. It is the ONLY correct dedup source: mid-`warming`
    // a request sits in neither `queue` (already shifted) nor `sessions` (not set
    // until materialise resolves), so a `queue`/`sessions` check would let a
    // duplicate `admit` slip through that window and orphan the live context.
    // (Keying off a Set also makes the check O(1).)
    const admitted = new Set<string>();

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

    // The one session whose `materialise` is in flight (the single pump means at
    // most one at a time) plus a flag `release()` sets to cancel it mid-`warming`.
    // Kept as a single slot, NOT a per-id set, precisely so a re-`admit` of the
    // same id can't confuse "this specific request was released" with "this id is
    // known" — `admitted` stays populated through warming, blocking re-admit.
    let warmingReq: AdmissionRequest | null = null;
    let warmingCancelled = false;

    function* sessionOp(
      m: Materialised<Ctx>,
      req: AdmissionRequest,
    ): Operation<void> {
      // Terminal state: `reaped` on a clean stop (a `release`/halt, or a harness
      // that ends on its own); `died` if the harness itself THROWS. It flips only
      // in the catch below — and in Effection a halt unwinds via ensure/finally
      // and never enters catch, so a normal release stays `reaped`.
      let outcome: "reaped" | "died" = "reaped";
      // Teardown runs LIFO — register the slot-drop FIRST (runs last) and the
      // dispose SECOND (runs first): on unwind we dispose the context BEFORE
      // dropping the slot + re-pumping, so occupancy never understates resident
      // memory and the pump can't over-admit while a context is still freeing.
      yield* ensure(() => {
        sessions.delete(req.sessionId);
        admitted.delete(req.sessionId); // id free to be re-admitted
        emit(req, { phase: outcome });
        kick();
      });
      yield* ensure(() => {
        // A throwing dispose must not abort teardown (the slot-drop above still
        // has to run) nor reject the halt promise — swallow it. Freeing the
        // context is the supplier's contract; a failure there is not the host's
        // to propagate.
        try {
          m.dispose();
        } catch {
          /* supplier's dispose failed — not the host's error to surface */
        }
      });
      try {
        yield* served.run(m, req.sessionId); // the UNCHANGED harness, concurrent
      } catch {
        // A harness ERROR (not a halt — halts bypass catch) is isolated to THIS
        // session: mark it `died` and SWALLOW, so an uncaught throw can't
        // propagate up the spawn into the pump and take down the host + every
        // sibling session.
        outcome = "died";
      } finally {
        // Clean stop → `draining` then `reaped`; a died session skips straight to
        // its terminal `died` (emitted by the slot-drop ensure above).
        if (outcome !== "died") emit(req, { phase: "draining" });
      }
    }

    // The admission pump — the sole ADMITTER: the only fiber that dequeues and
    // writes NEW `sessions` entries. (`admit` only enqueues at the tail after an
    // O(1) `admitted` dedup check; a session's own teardown ensure removes its id.)
    // Non-reentrant by being one fiber, so `materialise`'s `await` is the only
    // suspension window — and that window is exactly why dedup keys off `admitted`
    // (which still holds the id mid-`warming`) rather than `queue`/`sessions`. The
    // harnesses it spawns run fully concurrently.
    yield* spawn(function* (): Operation<void> {
      for (;;) {
        dirty = false;
        while (queue.length > 0 && sessions.size < maxNativeSessions) {
          const req = queue.shift()!;
          warmingReq = req;
          warmingCancelled = false;
          emit(req, { phase: "warming" });
          let m: Materialised<Ctx>;
          try {
            m = yield* call(() => served.materialise(req.sessionId));
          } catch {
            // Typed rejection for THIS request, not a dead pump. Release the id
            // (nothing else was inserted) so a later admit can retry it.
            warmingReq = null;
            admitted.delete(req.sessionId);
            emit(req, { phase: "died" });
            continue;
          }
          warmingReq = null;
          if (warmingCancelled) {
            // `release()` cancelled this session while its context was being built
            // (transport gone). Discard the just-built context and never spawn a
            // consumer-less harness. The id frees HERE — the pump owns the delete
            // on the cancel path, so a re-admit stayed blocked until now.
            admitted.delete(req.sessionId);
            try {
              m.dispose();
            } catch {
              /* freeing a just-built context — not the host's error to surface */
            }
            emit(req, { phase: "reaped" });
            continue;
          }
          const task = yield* spawn(() => sessionOp(m, req));
          sessions.set(req.sessionId, {
            ...m,
            sessionId: req.sessionId,
            task,
            cancel: () => {
              // Fire-and-forget halt: swallow a teardown rejection so it can't
              // surface as an unhandled promise rejection. (`release()` returns
              // the promise for callers that want to await the teardown.)
              void task.halt().catch(() => {});
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
        // Refuse a duplicate: an id already queued, warming, or live would, once
        // the pump ran, overwrite the live record and orphan its context. Gate on
        // `admitted` (NOT `queue`/`sessions`) — it still holds the id during the
        // `warming` window, where the request is in neither structure.
        if (admitted.has(req.sessionId)) {
          emit(req, { phase: "died" });
          return;
        }
        admitted.add(req.sessionId);
        emit(req, { phase: "queued", position: queue.length });
        queue.push(req);
        kick();
      },
      release(sessionId) {
        // Live: halt the harness scope (context frees on unwind, pump re-pumps).
        const rec = sessions.get(sessionId);
        if (rec) return rec.task.halt();
        // Warming (materialise in flight for this id): flag it so the pump discards
        // the just-built context instead of spawning. Leave `admitted` to the
        // pump's cancel path (keeps a re-admit blocked until the discard completes).
        if (warmingReq?.sessionId === sessionId) {
          warmingCancelled = true;
          return Promise.resolve();
        }
        // Queued (behind the cap): pull it out, free its id, re-pump — it never
        // materialises, so no consumer-less harness is ever spawned.
        const idx = queue.findIndex((q) => q.sessionId === sessionId);
        if (idx >= 0) {
          const [req] = queue.splice(idx, 1);
          admitted.delete(sessionId);
          emit(req, { phase: "reaped" });
          kick();
        }
        return Promise.resolve();
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
