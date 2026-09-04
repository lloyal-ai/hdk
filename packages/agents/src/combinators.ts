import { until } from 'effection';
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
 * So the issuing operation owns the decode's lifetime. `until(p)` in the body
 * carries the result; the `finally` — which Effection guarantees to run on
 * halt and lets us yield within — waits for `p` to settle, swallowing its
 * outcome (a body rejection is already the caller's). The wait is bounded to
 * the one call in flight: on the serial loop fiber that is a single step or a
 * single prefill.
 *
 * @param p - The promise returned by a native-backed SDK call.
 * @returns The resolved value on the normal path; the body rejection propagates.
 *
 * @category Agents
 */
export function* waitUntilSettled<T>(p: Promise<T>): Operation<T> {
  try {
    return yield* until(p);
  } finally {
    yield* until(Promise.allSettled([p]));
  }
}
