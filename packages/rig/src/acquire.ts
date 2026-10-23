/**
 * Ownership begins with the request. A scope that asks the native runtime for a context owns whatever comes
 * back — including a context that is still loading when the scope is asked to leave, which is what a halt
 * during a long model load produces. The scope does not leave until the creation has settled, and what
 * settled is freed on the way out: no continuation outlives the scope, and nothing is freed under a stage
 * still running on it. A creation built in stages is two of these, and the scope's LIFO teardown frees the
 * later stage first.
 *
 * Node-free: nothing here knows what it acquires.
 *
 * @category Rig
 */
import { ensure, until } from 'effection';
import type { Operation } from 'effection';

/**
 * Run `create` and hold its result for the calling scope: on any exit the scope waits for the creation to
 * settle, disposes what it produced, and, when `dispose` answers a promise, waits until it is freed. A
 * rejection has nothing to dispose. A `dispose` that throws or rejects never stops the scope from closing.
 */
export function* acquire<T>(create: () => Promise<T>, dispose: (value: T) => void | Promise<void>): Operation<T> {
  const pending = create();
  // Settled either way: the value is gone whether its free succeeded or not.
  const free = (value: T): Promise<unknown> => {
    try { return Promise.resolve(dispose(value)).catch(() => undefined); } catch { return Promise.resolve(); }
  };
  // Registered BEFORE the wait, so a halt while the promise is pending still ends in a free — after the
  // arrival, which the teardown waits for.
  yield* ensure(function* () {
    const settled = yield* until(pending.then((value) => ({ value }), () => null));
    if (settled) yield* until(free(settled.value));
  });
  return yield* until(pending);
}
