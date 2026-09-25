/**
 * Ownership begins with the request. A scope that asks the native runtime for a context owns whatever comes
 * back — including a context that arrives after the scope has already left, which is what a halt during a
 * long model load produces. Registering the teardown only once the promise has resolved leaves that gap;
 * this registers it first.
 *
 * Node-free: nothing here knows what it acquires.
 *
 * @category Rig
 */
import { call, ensure } from 'effection';
import type { Operation } from 'effection';

/**
 * Run `create` and hold its result for the calling scope: on any exit the value is disposed, and a value
 * that resolves after the exit is disposed on arrival. A rejection has nothing to dispose. A `dispose` that
 * throws never stops the scope from closing.
 */
export function* acquire<T>(create: () => Promise<T>, dispose: (value: T) => void): Operation<T> {
  const pending = create();
  let held: T | undefined;
  let released = false;
  const free = (value: T): void => { try { dispose(value); } catch { /* the value is gone either way */ } };
  // Registered BEFORE the wait, so a halt while the promise is pending still ends in a free — deferred to the
  // promise's own continuation, which is the only place the value can be reached from once the scope is gone.
  yield* ensure(() => {
    released = true;
    if (held !== undefined) free(held);
    else void pending.then(free, () => {});
  });
  const value = yield* call(() => pending);
  if (released) {
    free(value);
    throw new Error('the scope ended during acquisition');
  }
  held = value;
  return value;
}
