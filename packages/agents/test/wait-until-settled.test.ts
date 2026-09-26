/**
 * `waitUntilSettled` is the one combinator between the pool and the native
 * store: an operation that issued a decode may exit only once that decode has
 * settled, even when halted, because the batch keeps writing the context
 * after the JS promise is dropped.
 *
 * Two properties, both under halt:
 *   - the halt does not resolve before the decode settled (the reason the
 *     combinator exists);
 *   - the halt is not LOST: nothing after the awaited call runs. Effection's
 *     contract warns that a `yield*` inside a `finally` takes the frame out of
 *     unwind mode, so after the cleanup the operation continues as if it had
 *     returned — which for the pool means bookkeeping and events on a store
 *     that is being torn down.
 */
import { describe, it, expect } from 'vitest';
import { run, sleep, spawn } from 'effection';
import { waitUntilSettled } from '../src/combinators';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('waitUntilSettled under halt', () => {
  it('waits for the decode to settle, and lets nothing run after the halted call', async () => {
    const decode = deferred<string>();
    let settledBeforeHaltResolved = false;
    let continued = false;
    let continuedPastNextSuspension = false;

    await run(function* () {
      const task = yield* spawn(function* () {
        yield* waitUntilSettled(decode.promise);
        continued = true;   // must never run: the task was halted mid-call
        yield* sleep(1);
        continuedPastNextSuspension = true;   // nor this: a lost halt is not re-applied later
      });
      yield* sleep(5);
      const halting = task.halt();
      // The decode lands while the halt is pending; the halt may only resolve after it.
      setTimeout(() => decode.resolve('landed'), 10);
      let haltResolved = false;
      decode.promise.then(() => { settledBeforeHaltResolved = !haltResolved; });
      yield* halting;
      haltResolved = true;
      yield* sleep(20);   // give a lost halt every chance to show itself
    });

    expect(settledBeforeHaltResolved, 'the halt resolved before the decode settled').toBe(true);
    expect(continued, 'execution continued past the halted call: the halt was lost').toBe(false);
    expect(continuedPastNextSuspension, 'the lost halt was not re-applied at the next suspension either').toBe(false);
  });
});
