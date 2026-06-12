/**
 * `cancellableFetch(url, init, opts)` — Effection-native HTTP with
 * scope-linked cancellation and a deadline timeout.
 *
 * Wraps the global `fetch` so:
 *
 * 1. **Outer-scope halt aborts the in-flight request.** The Effection
 *    `useAbortSignal()` returns a signal linked to the current scope;
 *    when the scope halts (because a containing operation throws,
 *    `race` chose another leg, the harness is cancelled, etc.) the
 *    signal aborts and the underlying socket closes. The fetch is
 *    *genuinely* cancelled — not abandoned.
 *
 * 2. **Timeout aborts the in-flight request.** A second leg sleeps for
 *    `opts.timeoutMs` and throws on completion. `race` halts whichever
 *    leg loses, propagating the abort the same way an outer halt does.
 *
 * Three current/planned consumers route through this primitive:
 *
 * - `@lloyal-labs/web-app/src/tools/fetch-page.ts` (post-migration —
 *   replaces raw `AbortController` + `setTimeout`, closes the latent
 *   socket-leak bug where a halted pool kept fetch-page sockets open).
 * - `@lloyal-labs/web-app/src/tools/keyless-search.ts` (post-migration
 *   — replaces the private `fetchWithTimeout` from which this primitive
 *   was lifted; zero behavior change, just consolidation).
 * - `@lloyal-labs/rig/src/bundle.ts` (`resolveAppEntry`) — fetches the
 *   signed catalog via `cancellableFetch` so a halted scope during
 *   resolution tears down cleanly. Used by `harness.dev install` to
 *   resolve names against the canonical channel.
 *
 * Third-party apps SHOULD use `cancellableFetch` for any HTTP they do
 * under structured concurrency, rather than reinventing the
 * `race + useAbortSignal` pattern.
 *
 * @packageDocumentation
 * @category Contract
 */

import type { Operation } from 'effection';
import { call, race, sleep, useAbortSignal } from 'effection';

/**
 * Options accepted by {@link cancellableFetch}.
 */
export interface CancellableFetchOptions {
  /**
   * Maximum time in milliseconds before the fetch is aborted with a
   * {@link FetchTimeoutError}. Default: 30000 (30 seconds). Set to
   * `Infinity` to disable the timeout (cancellation via outer scope
   * still works).
   */
  timeoutMs?: number;
  /**
   * Inject a non-default `fetch` implementation for testing or for
   * harnesses that proxy network access. Defaults to the global `fetch`.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Thrown when the timeout leg of `cancellableFetch` wins the race.
 * Distinct from generic `Error` so consumers can catch only the
 * timeout case (e.g., to retry with a longer timeout) without also
 * catching network-layer errors thrown from the fetch leg.
 */
export class FetchTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Fetch timed out after ${timeoutMs}ms: ${url}`);
    this.name = 'FetchTimeoutError';
  }
}

/**
 * Default request timeout. Chosen to be comfortably longer than typical
 * web pages (95th percentile of `fetch-page.ts` traces resolves in under
 * 10s) while still bounded enough to fail fast on dead URLs. Override
 * via `opts.timeoutMs` for known-slow endpoints.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Fetch a URL with Effection-scope-linked cancellation and a timeout.
 *
 * @param url - The URL to fetch.
 * @param init - Standard `RequestInit` options. `init.signal` is *replaced*
 *   by the Effection-scope-linked signal; callers cannot pass their own
 *   AbortController. (If you want to compose with an external abort
 *   source, do it at the outer-scope level — halting the outer scope
 *   propagates here.)
 * @param opts - Timeout + injection knobs.
 * @returns The `Response` object — unread. Callers `yield* call(() => res.text())`
 *   etc. as appropriate to their use case.
 *
 * @throws {FetchTimeoutError} If the timeout leg wins.
 * @throws Network-layer errors thrown by the underlying `fetch` (e.g., DNS
 *   resolution failure, TLS error, socket reset). When the abort signal
 *   fires, `fetch` throws a `DOMException` with `name === 'AbortError'` —
 *   distinguishable from real network errors by that name.
 *
 * **Body buffering.** The returned `Response`'s body is **fully buffered
 * in memory** before the function returns; the caller may safely call
 * `.text()` / `.json()` / `.arrayBuffer()` on it without further async
 * coordination. This is load-bearing: the underlying `useAbortSignal()`
 * aborts when the http leg's scope unwinds (after `race` resolves),
 * which would otherwise cause the caller's body-read to throw
 * `AbortError` mid-flight (the body is still bound to the request's
 * signal in undici). Pre-consuming inside the http leg, before the
 * signal aborts, sidesteps that interaction. Cost: streaming is not
 * supported — all responses are fully resident before return. Acceptable
 * for the consumers we have (catalog JSON, manifest JSON, signed
 * bundles up to a few hundred KB).
 */
export function* cancellableFetch(
  url: string,
  init?: RequestInit,
  opts?: CancellableFetchOptions,
): Operation<Response> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts?.fetchImpl ?? fetch;

  const httpLeg = function* (): Operation<Response> {
    const signal = yield* useAbortSignal();
    // Strip caller's signal if any — the Effection scope owns abort.
    // Keeping caller-supplied signal would mean two abort sources, which
    // confuses the cancellation chain.
    const { signal: _ignored, ...restInit } = init ?? {};
    const res = yield* call(() => fetchImpl(url, { ...restInit, signal }));
    // Pre-consume the body while the signal is still live. After `race`
    // returns, this http leg's scope unwinds and the signal aborts —
    // reading the original Response's body at that point throws
    // AbortError from undici's consumeBody. Wrapping the buffered bytes
    // in a fresh Response (which has no associated signal) lets the
    // caller read the body on their own schedule.
    const bytes = yield* call(() => res.arrayBuffer());
    return new Response(bytes, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };

  const timeoutLeg = function* (): Operation<Response> {
    if (timeoutMs === Infinity) {
      // Sleep forever — the http leg will win or the outer scope halts.
      // Using a deliberately-never-resolving operation rather than
      // sleeping for MAX_SAFE_INTEGER ms (which Node's timer subsystem
      // doesn't handle gracefully).
      yield* call(() => new Promise<never>(() => { /* never resolves */ }));
      // Unreachable, but type-required.
      throw new FetchTimeoutError(url, timeoutMs);
    }
    yield* sleep(timeoutMs);
    throw new FetchTimeoutError(url, timeoutMs);
  };

  return yield* race([httpLeg(), timeoutLeg()]);
}
