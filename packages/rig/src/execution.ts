/**
 * The execution owner: one live operation per session, accepted at once and
 * sequenced in the owner's own loop.
 *
 * A harness runs long work — a plan, a fan-out, a settling pass — under one
 * owner so that a replacement waits for the previous operation's teardown
 * (every `ensure`, `waitUntilSettled`'s settle barrier included) before it
 * touches the model, and so that Stop reaches whatever is live. Nothing a
 * handler calls here waits on native work: `replace` and `stop` post to the
 * mailbox and return, the loop halts then starts, and `busy` holds until the
 * halt has completed. That is what keeps a command loop dispatching during the
 * slowest cleanup, and what lets a continuation accepted behind a closing turn
 * be withdrawn before it starts.
 *
 * Completion is the operation's own return; an ordinary failure is reported by
 * the operation and recorded on its future, and does not poison the owner. A
 * halt whose teardown throws is not ordinary: nothing may run again on that
 * model state, so the owner is `poisoned`, the accepted operation's future
 * rejects with the teardown error, and `replace` and `stop` throw from then on.
 * An error the operation raises while it is being halted is READ as its
 * teardown's and poisons the same way. That is a reading, not a fact the owner
 * can establish: an operation that owns a `scoped()` boundary holds its own
 * body's error inside that boundary while its cleanup runs, so a body failure
 * arrives by the same route, and at the same moment, a cleanup failure would.
 * Effection offers no channel that separates them — a child task does not
 * either; both come through the halt. So the fatal reading is the default,
 * because a cleanup that failed leaves the model's state untrustworthy, and an
 * operation that KNOWS the difference says so by throwing
 * {@link OperationFailure}. A cleanup registered without such a boundary needs
 * none of this: it runs on the owner's own frame and its failure is reported by
 * the halt itself.
 * The application decides what a poisoned owner means — for a harness, ending
 * the session.
 *
 * The controls — pause, resume, wrap up, cancel one agent — send the ambient
 * signals the pool reads ({@link Pause}, {@link WindDown}, {@link CancelAgent})
 * for the operation that runs, and only then: paused and winding down are the
 * operation's own facts and start clean with each one. Without the signals in
 * context the controls do nothing.
 *
 * @category Rig
 */
import { resource, scoped, spawn, createQueue, withResolvers } from 'effection';
import type { Operation, Task, Signal } from 'effection';
import { Pause, WindDown, CancelAgent } from '@lloyal-labs/lloyal-agents';

/** What the harness holds. */
export interface Execution {
  /**
   * Accept `op` as the session's next operation, replacing whatever runs.
   * Returns at once with the operation's future: it resolves when the
   * operation returns, when a later `replace` or a `stop` withdraws it before
   * it started, or once the halt that stopped it has completed; it rejects
   * with the operation's own error, or with a teardown error that poisoned
   * the owner. `id` is what `current` reports.
   */
  replace(id: string, op: () => Operation<void>): Operation<Operation<void>>;
  /** Withdraw an accepted operation that has not started, and halt the one running. Returns at once. */
  stop(): Operation<void>;
  /** The id of the operation running or accepted; `null` when idle. */
  readonly current: string | null;
  /** True from acceptance until the last operation's halt has completed. */
  readonly busy: boolean;
  /** A halt's teardown threw: nothing runs on this model state again. */
  readonly poisoned: boolean;
  /**
   * Settles with the teardown error the moment the owner poisons, so the
   * application can say so and end on its own.
   *
   * Without it nothing happens at all until the reader's next command trips
   * over {@link poisoned}: the session is half-dead — browsing, search and
   * settings all still answer, because only `replace` and `stop` consult the
   * flag — and the failure is announced on the reader's action, which makes
   * their question look like its cause. Never settles on a healthy owner.
   */
  readonly whenPoisoned: Operation<Error>;
  /** Hold the running operation at the pool's next tick boundary. Nothing while idle, paused or winding down. */
  pause(): void;
  /** Release a held operation. Nothing unless paused. */
  resume(): void;
  /** Drain the running operation to whatever it has: the pool stops spawning and reaps to recovery. Once per operation; nothing while paused. */
  wrapUp(): void;
  /** Discard one live agent of the running operation. Nothing while idle. */
  cancel(agentId: number): void;
}

interface Accepted {
  id: string;
  op: () => Operation<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * What an operation throws to say a failure is its OWN, not its teardown's.
 *
 * The owner cannot tell the two apart once an operation owns a `scoped()` boundary: a body error is
 * held inside that boundary while its cleanup runs, so it surfaces at the same place, by the same
 * route, and at the same moment as a cleanup error would — after a halt may already have begun.
 * Effection offers no separate channel for them (a child task does not separate them either; both
 * arrive through the halt). So the fact has to be carried by whoever still knows it, which is the
 * operation's own handler at the point the body failed.
 *
 * Unmarked is the safe reading: an error arriving while the operation is being halted is taken to be
 * the teardown's and poisons, because a cleanup that failed leaves the model's state untrustworthy.
 */
export class OperationFailure extends Error {
  constructor(readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = 'OperationFailure';
  }
}

const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/**
 * Create the session's execution owner. A resource: its loop and every
 * operation it starts are children of the caller's scope, halted with it.
 */
export function useExecution(): Operation<Execution> {
  return resource(function* (provide) {
    // The controls' signals: optional capabilities a boot publishes; absent ⇒ no-ops.
    let pauseSignal: Signal<boolean, void> | null = null;
    let windDownSignal: Signal<void, void> | null = null;
    let cancelSignal: Signal<{ agentId: number }, void> | null = null;
    try { pauseSignal = (yield* Pause.get()) ?? null; } catch { /* none */ }
    try { windDownSignal = (yield* WindDown.get()) ?? null; } catch { /* none */ }
    try { cancelSignal = (yield* CancelAgent.get()) ?? null; } catch { /* none */ }
    let paused = false;
    let windingDown = false;
    // One wake for everything that changes the loop's work: added from the
    // handlers' operations, read by the loop alone.
    const wake = createQueue<void, never>();
    let running: { id: string; task: Task<void>; accepted: Accepted } | null = null;
    /** The operation being halted right now: an error it raises meanwhile is its teardown's. */
    let halting: Task<void> | null = null;
    let pending: Accepted | null = null;
    let stopRequested = false;
    let poison: Error | null = null;
    // Settled once, from the one place that poisons. A waiter on a healthy owner waits forever,
    // which is what an application racing it against its command loop wants.
    const poisoned = withResolvers<Error>('execution.poisoned');
    let current: string | null = null;
    let busy = false;

    const refuse = (): void => {
      if (poison) throw new Error(`the execution owner is poisoned: ${poison.message}`);
    };
    /** An accepted operation that never started settles as withdrawn. */
    const withdraw = (): void => {
      if (!pending) return;
      pending.resolve();
      pending = null;
    };
    const idle = (): void => {
      busy = false;
      current = null;
      paused = false;
      windingDown = false;
    };

    yield* spawn(function* loop() {
      for (;;) {
        yield* wake.next();
        // A wake with nothing to do is stale — a replacement already started, or
        // a stop already took effect — and must not halt what runs now.
        if (running && (pending || stopRequested)) {
          const r = running;
          halting = r.task;
          try {
            yield* r.task.halt();
          } catch (err) {
            // Teardown failed: the model's state cannot be trusted. Nothing
            // starts; the halted and the accepted operation hear why; the owner refuses from now on.
            poison = toError(err);
            poisoned.resolve(poison);
            running = null;
            stopRequested = false;
            r.accepted.reject(poison);
            if (pending) {
              pending.reject(poison);
              pending = null;
            }
            halting = null;
            idle();
            continue;
          }
          halting = null;
          running = null;
          r.accepted.resolve(); // stopped: its future settles once the halt has completed
        }
        stopRequested = false;
        if (!pending) {
          if (!running) idle();
          continue;
        }
        const next = pending;
        pending = null;
        paused = false;      // the operation's own facts start clean
        windingDown = false;
        const task: Task<void> = yield* spawn(function* () {
          // Whose failure was it? `halting` answers when the error ARRIVED, never where it came
          // from, and for an operation that owns a boundary those differ: its body's error waits
          // inside while the cleanup runs, and lands after a stop has begun. Unmarked stays the
          // teardown's — the safe reading — and `OperationFailure` is the operation saying otherwise.
          const body: { failed: boolean; err?: unknown } = { failed: false };
          const reasonOf = (e: unknown): unknown => (e instanceof OperationFailure ? e.reason : e);
          try {
            // The owner's own boundary, so the barrier it promises is the owner's to keep and not
            // the caller's to remember: `scoped` returns only once the operation's frame has closed
            // and every `ensure` it registered has run. Without it a natural return settles the
            // future — and frees `busy` — while the operation is still tearing down, and a
            // replacement could touch the model underneath it. A halt already waited (`task.halt()`).
            yield* scoped(function* () {
              try { yield* next.op(); } catch (err) {
                if (!(err instanceof OperationFailure) && halting === task) throw err;
                body.failed = true;
                body.err = reasonOf(err);
              }
            });
            // Past the boundary, so the teardown itself succeeded: the body's outcome is the
            // operation's, whatever else was in flight while it unwound.
            if (body.failed) next.reject(toError(body.err)); else next.resolve();
          } catch (err) {
            // The owner's own frame failed to close, or the operation reported past the boundary.
            if (!(err instanceof OperationFailure) && halting === task) throw err;   // the teardown's, and the halt's to fail with
            next.reject(toError(reasonOf(err)));
          } finally {
            // The operation ended on its own. Unless a replacement is already
            // accepted (the wake will start it), the owner is free.
            if (running?.task === task) {
              running = null;
              if (!pending) idle();
            }
          }
        });
        running = { id: next.id, task, accepted: next };
      }
    });

    yield* provide({
      *replace(id, op) {
        refuse();
        withdraw();
        const future = withResolvers<void>('execution');
        pending = { id, op, resolve: () => future.resolve(), reject: future.reject };
        busy = true;
        current = id;
        wake.add();
        return future.operation;
      },
      *stop() {
        refuse();
        withdraw();
        if (running) {
          stopRequested = true;
          wake.add(); // the loop halts it; `busy` holds until the halt completes
        } else {
          idle();
        }
      },
      get current() { return current; },
      get busy() { return busy; },
      get poisoned() { return poison !== null; },
      whenPoisoned: poisoned.operation,
      pause() {
        if (!running || paused || windingDown) return;
        paused = true;
        pauseSignal?.send(true);
      },
      resume() {
        if (!paused) return;
        paused = false;
        pauseSignal?.send(false);
      },
      wrapUp() {
        if (!running || paused || windingDown) return;
        windingDown = true;
        windDownSignal?.send();
      },
      cancel(agentId) {
        if (!running) return;
        cancelSignal?.send({ agentId });
      },
    });
  });
}
