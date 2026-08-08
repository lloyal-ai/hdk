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
 */

/** How long headers may take to arrive, unless a caller overrides it. */
export const HEADERS_TIMEOUT_MS = 30_000;

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
      throw new Error(
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
