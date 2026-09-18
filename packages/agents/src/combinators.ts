import { until, scoped, ensure } from 'effection';
import type { Operation } from 'effection';

/**
 * Sequential fold over an array where each iteration is an Effection Operation.
 *
 * Like `Array.reduce` but each step can yield to async operations, spawn
 * agents, or perform any Effection work. Used by harnesses to fold across
 * sources, accumulating findings and threading enriched questions forward.
 *
 * @param items - Array to fold over
 * @param init - Initial accumulator value
 * @param fn - Reducer function returning an Operation that produces the next accumulator
 * @returns Final accumulated value
 *
 * @example Fold across sources
 * ```typescript
 * const findings = yield* reduce(
 *   sources,
 *   { sections: [], questions },
 *   function*(acc, source, i) {
 *     const pool = yield* agentPool({ tasks: acc.questions, ... });
 *     return { sections: [...acc.sections, ...collected], questions: enriched };
 *   },
 * );
 * ```
 *
 * @category Agents
 */
export function* reduce<T, A>(
  items: T[],
  init: A,
  fn: (acc: A, item: T, i: number) => Operation<A>,
): Operation<A> {
  let acc = init;
  for (let i = 0; i < items.length; i++) {
    acc = yield* fn(acc, items[i], i);
  }
  return acc;
}


/**
 * Yield on a promise-backed operation, but exit only once the promise has
 * SETTLED — even when the enclosing operation is halted.
 *
 * A native store decode (`store.commit`, `store.prefill`) is queued onto the
 * libuv thread pool and cannot be recalled. `until(p)` alone abandons `p` on
 * halt: the JS side moves on while the batch keeps writing the context's KV.
 * If teardown then prunes or disposes, two writers touch one seq — a lease
 * handed back dirty, or a segfault.
 *
 * So the issuing operation owns the decode's lifetime: `until(p)` carries the
 * result, and the settle-wait is registered with `ensure()` inside a
 * `scoped()` boundary, so it runs on return, error AND halt. It is not a
 * `finally`: Effection's contract forbids a `yield*` inside one, because the
 * halt unwinds the generator with `return()`, a yielding `finally` suspends
 * that frame, and the resume takes it out of unwind mode — the cleanup runs
 * and then execution continues past the halted call as if it had returned
 * (`test/wait-until-settled.test.ts` shows the halt being lost that way).
 * `ensure()` is driven by scope destruction, which is non-interruptible.
 *
 * The wait is bounded to the one call the issuing operation has in flight — a
 * single step or a single prefill — so halting stays speedy in the only sense
 * available. Every Effection site that awaits a store decode goes through
 * this; `test/native-await-invariant.test.ts` refuses a bare
 * `call(() => …prefill())` and `test/effection-contract.test.ts` refuses a
 * yielding `finally`, so the rule is checked, not remembered.
 *
 * @param p - The promise returned by a native-backed SDK call.
 * @returns The resolved value on the normal path; the body rejection propagates.
 *
 * @category Agents
 */
export function waitUntilSettled<T>(p: Promise<T>): Operation<T> {
  return scoped(function* () {
    yield* ensure(() => until(Promise.allSettled([p])));
    return yield* until(p);
  });
}
