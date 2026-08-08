/**
 * `fetch` with a deadline on the response HEADERS.
 *
 * Node's fetch has no default timeout, so a blackholed egress — a firewall that
 * DROPs instead of REJECTing, a proxy that accepts the connection and never
 * answers — hangs forever instead of failing. A refused or unresolvable host
 * fails fast on its own; it is the silent-drop case this exists for.
 *
 * That became reachable from every scaffold in 0.8.0, when vendoring a
 * template's default apps stopped being gated on a TTY: a CI runner without
 * egress now waits indefinitely where it used to return immediately.
 *
 * **The deadline covers only the wait for headers**, and is cleared the moment
 * `fetch` resolves. That is deliberate, not an oversight: `models.ts`
 * `streamToFile` pulls multi-gigabyte `.gguf` weights through here, and a
 * total-elapsed timeout would abort a perfectly healthy slow download. The
 * failure being guarded is "the server never answered", which is entirely a
 * headers-phase failure. A body that starts flowing and then stalls is a
 * different and much rarer problem, and is deliberately left alone.
 *
 * ## Why not `@lloyal-labs/rig`'s `cancellableFetch`
 *
 * It exists (`packages/rig/src/cancellable-fetch.ts`) and covers the same ground
 * — `timeoutMs`, a `FetchTimeoutError`, a `fetchImpl` seam. It is not used here
 * for three reasons, the last decisive:
 *
 * 1. **Dependency boundary.** harness-cli depends on `@inkjs/ui`, `ink` and
 *    `react`, nothing else. Importing rig breaches the Apache/FSL + zero-native
 *    line that `verify.ts` exists to hold (rig chain-imports native
 *    `lloyal.node`).
 * 2. **Shape.** `cancellableFetch` is an Effection `Operation`; adopting it turns
 *    every call site here into a generator and adds `effection` as a runtime dep.
 * 3. **It buffers.** Its own docblock: *"the returned Response's body is fully
 *    buffered in memory before the function returns… streaming is not supported…
 *    Acceptable for the consumers we have (catalog JSON, manifest JSON, signed
 *    bundles up to a few hundred KB)."* `models.ts` `streamToFile` pulls
 *    multi-gigabyte `.gguf` weights through this path. Porting rig's semantics
 *    faithfully would buffer those into memory and abort them on its
 *    whole-request race — the same trap as `AbortSignal.timeout`.
 *
 * The error type is named to MATCH rig's, so one idea keeps one word on both
 * sides of the boundary even though the code cannot be shared. The message does
 * not match: this surface must state the recovery inline for a first-time user.
 *
 * **Task #465.** This file and `verify.ts` are now two instances of the same
 * thing — a rig primitive re-authored here because of the native-dep chain. Both
 * belong in the planned Apache-native, zero-native `@lloyal-labs/channel-verify`
 * extraction; a fetch-with-deadline sits naturally beside the verify surface.
 */

/** How long headers may take to arrive, unless a caller overrides it. */
export const HEADERS_TIMEOUT_MS = 30_000;

/**
 * Thrown when the headers deadline fires. Deliberately the same class name as
 * `@lloyal-labs/rig`'s `FetchTimeoutError` — the CLI cannot import that one (see
 * the note above), but a reader moving between the two should not have to learn
 * a second word for the same failure.
 */
export class FetchTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchTimeoutError';
  }
}

/**
 * Fetch `url`, aborting if the response headers do not arrive within
 * `timeoutMs`. Throws a message that names the host and the recovery, so it can
 * be surfaced verbatim to someone running the CLI for the first time.
 *
 * No caller passes its own `signal` today; if one ever needs to, combine it here
 * rather than bypassing this wrapper.
 */
export async function httpFetch(
  url: string | URL,
  init: RequestInit = {},
  timeoutMs: number = HEADERS_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    // Distinguish OUR deadline from a caller-visible network error: the abort we
    // fired is the only reason this signal can be aborted (see the doc note).
    if (controller.signal.aborted) {
      throw new FetchTimeoutError(
        `timed out after ${humanMs(timeoutMs)} waiting for ${hostOf(url)} to respond — ` +
          'check your network or proxy, then re-run.',
      );
    }
    throw err;
  } finally {
    // Runs as soon as headers land (or the request fails), which is what makes
    // this a headers deadline rather than a whole-request one.
    clearTimeout(timer);
  }
}

/** `30000` → `30s`, `100` → `100ms` — never the nonsense "0s". */
function humanMs(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}

/** Host for the error message; falls back to the raw input if it won't parse. */
function hostOf(url: string | URL): string {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}
