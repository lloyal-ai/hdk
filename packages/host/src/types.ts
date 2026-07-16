/**
 * The two host types + the injected-harness seam. Deliberately
 * generic over the context type `Ctx` so this package imports NO harness and NO
 * `@lloyal-labs/sdk` — under B, a caller instantiates it with `SessionContext`.
 */
import type { Operation, Task, Signal } from "effection";
import type { EventBus, SessionState } from "@lloyal-labs/binding";

export type { SessionState };

/**
 * The per-session substrate a harness supplier builds. The host holds these and
 * routes `uiChannel`/`commands` to the transport; `dispose()` frees the context.
 * The event/command payloads are opaque to the host (the binding is
 * payload-opaque), so they are typed `unknown` here.
 */
export interface Materialised<Ctx = unknown> {
  /** The compute context (a `SessionContext` under B). */
  context: Ctx;
  /** This session's event bus — the harness sends `WorkflowEvent`s here. */
  uiChannel: EventBus<unknown>;
  /** This session's command signal — the transport `send`s into it. */
  commands: Signal<unknown, void>;
  /** Free the context. Called by the host on teardown, BEFORE the slot is dropped. */
  dispose(): void;
}

/**
 * The harness-specific half, injected by the harness package (e.g. reasoning.run
 * via its `./runner` served export). The host calls exactly these two functions
 * and never imports a harness — this is a DI seam, not a placement abstraction
 * (the reserved-extension guardrail: keep it to two functions).
 */
export interface ServedHarness<Ctx = unknown> {
  /** Build the per-session substrate over the resident model. Called ON the
   *  admission pump, so context construction is serialised. All model/context
   *  params live in the supplier — never in the host. */
  materialise(sessionId: string): Promise<Materialised<Ctx>>;
  /** Set the harness's runner context + run its unchanged `harness(ctx,…)` scope.
   *  Long-running; the host spawns it as a per-session structured child. */
  run(m: Materialised<Ctx>, sessionId: string): Operation<void>;
}

/** What `createModelRuntimeHost` needs. */
export interface ModelRuntimeHostOpts<Ctx = unknown> {
  /** The injected harness supplier (materialise + run). */
  served: ServedHarness<Ctx>;
  /** Resident-session cap; FIFO admission behind it (the MVP admission proxy). */
  maxNativeSessions: number;
}

/** What a caller enqueues to admit a Session. */
export interface AdmissionRequest {
  sessionId: string;
  /** The host calls this on every `SessionState` transition
   *  (queued→warming→live→draining→reaped, or →died). The transport turns these
   *  into `session`-plane wss frames; a caller learns its Session's fate here. */
  onState?(state: SessionState): void;
}

/**
 * A materialised, running-harness embodiment of one
 * Session. `sessions.size` (Map of these) IS the occupancy ledger — no counter.
 */
export interface NativeSessionRecord<Ctx = unknown> extends Materialised<Ctx> {
  sessionId: string;
  /** The spawned harness scope. `cancel()` halts it → the context frees on unwind. */
  task: Task<void>;
  cancel(): void;
}
