import {
  action,
  call,
  race,
  resource,
  sleep,
  spawn,
  useAbortSignal,
  useScope,
} from "effection";
import type { Operation } from "effection";
import type { SearchProvider, SearchResult } from "./types";

// ── Endpoints ───────────────────────────────────────────────────

const DDG_URL = "https://html.duckduckgo.com/html/";
const MARGINALIA_URL = "https://api2.marginalia-search.com/search";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
]);

// ── Public types ────────────────────────────────────────────────

/**
 * Configuration for {@link createKeylessSearchProvider}.
 *
 * The defaults are tuned for residential-IP safety: ~1 request every 3–5 s
 * to the primary engine. Lowering `paceBaseMs` below the default risks
 * being blocked by DuckDuckGo. Setting it to zero throws at construction.
 *
 * @category Rig
 */
export interface KeylessSearchOptions {
  /** Pacer base interval in ms between primary-engine requests. @default 3000 */
  paceBaseMs?: number;
  /** Pacer jitter added on top of base (uniform [0, paceJitterMs)). @default 2000 */
  paceJitterMs?: number;
  /** Consecutive hard failures before the breaker opens. @default 2 */
  breakerThreshold?: number;
  /** Ms the breaker stays open before allowing a half-open probe. @default 15000 */
  breakerCooldownMs?: number;
  /** Per-request timeout in ms (must stay below fetch-page's 10s ceiling). @default 8000 */
  requestTimeoutMs?: number;
  /** User-Agent header to send to the primary engine. */
  userAgent?: string;
  /**
   * Sleep operation used by the pacer and timeout race. Defaults to
   * effection's `sleep`. Tests inject a tick-driven mock for determinism.
   */
  sleepOp?: (ms: number) => Operation<void>;
  /** Fetch implementation. Defaults to global `fetch`. Tests inject mocks. */
  fetchImpl?: typeof fetch;
}

// ── Internal: breaker ───────────────────────────────────────────

type BreakerState = "closed" | "open" | "half-open";

interface Breaker {
  canProceed(): boolean;
  onSuccess(): void;
  onHardFailure(): void;
  readonly state: BreakerState;
}

function createBreaker(threshold: number, cooldownMs: number): Breaker {
  let state: BreakerState = "closed";
  let failures = 0;
  let openedAt = 0;
  return {
    canProceed(): boolean {
      if (state === "closed" || state === "half-open") return true;
      if (Date.now() - openedAt >= cooldownMs) {
        state = "half-open";
        return true;
      }
      return false;
    },
    onSuccess(): void {
      state = "closed";
      failures = 0;
    },
    onHardFailure(): void {
      if (state === "half-open") {
        state = "open";
        openedAt = Date.now();
        failures = threshold;
        return;
      }
      failures++;
      if (failures >= threshold) {
        state = "open";
        openedAt = Date.now();
      }
    },
    get state(): BreakerState {
      return state;
    },
  };
}

// ── Internal: pacer ─────────────────────────────────────────────

interface Pacer {
  acquire(): Operation<void>;
}

/**
 * Scope-owned shared pacer. A single internal `spawn` loop pops one waiter
 * per jittered interval. Concurrent callers wait their turn via `action()`;
 * the action's cleanup deregisters a waiter if its caller scope halts before
 * release, so cancelled callers never resolve into a stale slot.
 *
 * No timestamp arithmetic per caller — central loop owns all timing.
 */
function useRequestPacer(opts: {
  baseMs: number;
  jitterMs: number;
  sleepOp: (ms: number) => Operation<void>;
}): Operation<Pacer> {
  return resource(function* (provide) {
    const waiters: Array<() => void> = [];
    yield* spawn(function* () {
      while (true) {
        const delay = opts.baseMs + Math.floor(Math.random() * opts.jitterMs);
        yield* opts.sleepOp(delay);
        const next = waiters.shift();
        if (next) next();
      }
    });
    yield* provide({
      acquire(): Operation<void> {
        return action<void>((resolve) => {
          const fn = () => resolve();
          waiters.push(fn);
          return () => {
            const i = waiters.indexOf(fn);
            if (i >= 0) waiters.splice(i, 1);
          };
        });
      },
    });
  });
}

// ── Internal: cancellable HTTP ──────────────────────────────────

class HardFailure extends Error {}

interface HttpResult {
  status: number;
  text: string;
}

/**
 * Effection-native cancellable timeout. `race` halts the loser on win, and
 * `useAbortSignal` aborts the underlying socket when the http leg is halted.
 * If the timeout wins, `HardFailure` is thrown and the in-flight fetch is
 * genuinely cancelled — not abandoned.
 */
function* fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  sleepOp: (ms: number) => Operation<void>,
): Operation<HttpResult> {
  const httpLeg = function* (): Operation<HttpResult> {
    const signal = yield* useAbortSignal();
    const res = yield* call(() => fetchImpl(url, { ...init, signal }));
    const text = yield* call(() => res.text());
    return { status: res.status, text };
  };
  const timeoutLeg = function* (): Operation<HttpResult> {
    yield* sleepOp(timeoutMs);
    throw new HardFailure(`Request timed out after ${timeoutMs}ms`);
  };
  return yield* race([httpLeg(), timeoutLeg()]);
}

// ── Internal: DDG parsing ───────────────────────────────────────

const HTML_ENTITY_RE = /&(amp|lt|gt|quot|#x27|#39);/g;
const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#x27": "'",
  "#39": "'",
};

function decodeHtml(s: string): string {
  return s.replace(HTML_ENTITY_RE, (_, e) => HTML_ENTITIES[e] ?? "");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
const HREF_RE = /\bhref="([^"]+)"/;
const CLASS_RE = /\bclass="([^"]*)"/;

/**
 * Extract `result__a` (title + href) and `result__snippet` anchors from a
 * DuckDuckGo HTML SERP. Returns an empty array on length-too-short or
 * zero-anchor output (treated as soft-block by the caller).
 */
function parseDdgHtml(html: string): SearchResult[] {
  if (!html || html.length < 200) return [];
  const titles: Array<{ url: string; title: string }> = [];
  const snippets: string[] = [];
  for (const m of html.matchAll(ANCHOR_RE)) {
    const attrs = m[1];
    const inner = m[2];
    const clsMatch = CLASS_RE.exec(attrs);
    if (!clsMatch) continue;
    const classes = clsMatch[1].split(/\s+/);
    if (classes.includes("result__a")) {
      const hrefMatch = HREF_RE.exec(attrs);
      if (!hrefMatch) continue;
      titles.push({
        url: decodeHtml(hrefMatch[1]),
        title: decodeHtml(stripTags(inner)),
      });
    } else if (classes.includes("result__snippet")) {
      snippets.push(decodeHtml(stripTags(inner)));
    }
  }
  const out: SearchResult[] = [];
  for (let i = 0; i < titles.length; i++) {
    out.push({
      title: titles[i].title,
      url: titles[i].url,
      snippet: snippets[i] ?? "",
    });
  }
  return out;
}

// ── Internal: Marginalia parsing ────────────────────────────────

interface MarginaliaResultRaw {
  url?: string;
  title?: string;
  description?: string;
}

interface MarginaliaResponse {
  results?: MarginaliaResultRaw[];
}

function parseMarginaliaJson(text: string): SearchResult[] {
  let data: MarginaliaResponse;
  try {
    data = JSON.parse(text) as MarginaliaResponse;
  } catch {
    return [];
  }
  if (!Array.isArray(data.results)) return [];
  const out: SearchResult[] = [];
  for (const r of data.results) {
    if (!r.url || !r.title) continue;
    const snippet = (r.description ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
    out.push({ title: r.title, url: r.url, snippet });
  }
  return out;
}

// ── Internal: URL normalization + dedup ─────────────────────────

/**
 * Normalize a candidate URL: drop fragment, lowercase host, expand
 * protocol-relative, strip common tracking params, reject non-http(s) and
 * `.pdf` paths (which fetch-page hard-rejects downstream — dead slots).
 */
function normalizeUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (s.startsWith("//")) s = "https:" + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const lowerPath = u.pathname.toLowerCase();
  if (
    lowerPath.endsWith(".pdf") ||
    lowerPath.endsWith(".pdf/") ||
    lowerPath.includes(".pdf?") ||
    lowerPath.includes(".pdf#")
  ) {
    return null;
  }
  for (const k of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(k.toLowerCase())) u.searchParams.delete(k);
  }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  return u.toString();
}

function dedupResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
  }
  return out;
}

// ── Factory ─────────────────────────────────────────────────────

/**
 * Create the keyless, in-process default {@link SearchProvider}.
 *
 * Two engines, primary with circuit-broken fallback:
 *
 * - **Primary**: DuckDuckGo HTML (`html.duckduckgo.com/html/`). Static,
 *   no-JS endpoint. Paced behind a shared FIFO request limiter to avoid
 *   triggering rate-limit responses on a residential IP. Wrapped in a
 *   circuit breaker that opens on consecutive hard failures (403/429/
 *   network/timeout) and recovers via a half-open probe after a cooldown.
 *
 * - **Fallback**: Marginalia public JSON API (`api2.marginalia-search.com`,
 *   shared `public` API key via header). Independent niche index;
 *   shared-key saturation surfaces as 503/429 and is treated as soft-empty.
 *
 * Returned results omit the `score` field by design — the upstream
 * `WebSearchTool` exploit-mode ranking falls back cleanly to entailment-only
 * when scores are absent, while a fabricated provider score would corrupt
 * `min(providerScore, entailment)`.
 *
 * The provider is bound to the scope where this factory is yielded — the
 * pacer's central tick loop is halted when that scope exits.
 *
 * @example
 * ```ts
 * yield* initAgents(ctx);
 * const provider = yield* createKeylessSearchProvider();
 * // Inject into an App factory (e.g. createWebApp) that constructs its
 * // Source bound to the provider + reranker.
 * ```
 *
 * @category Rig
 */
export function createKeylessSearchProvider(
  opts: KeylessSearchOptions = {},
): Operation<SearchProvider> {
  return resource(function* (provide) {
    const paceBaseMs = opts.paceBaseMs ?? 3000;
    const paceJitterMs = opts.paceJitterMs ?? 2000;
    if (paceBaseMs <= 0) {
      throw new Error(
        "createKeylessSearchProvider: paceBaseMs must be > 0. Unpaced egress on a residential IP is unsafe — fail loudly rather than risk being blocked silently.",
      );
    }
    if (paceJitterMs < 0) {
      throw new Error(
        "createKeylessSearchProvider: paceJitterMs must be >= 0.",
      );
    }
    const breakerThreshold = opts.breakerThreshold ?? 2;
    const breakerCooldownMs = opts.breakerCooldownMs ?? 15_000;
    const requestTimeoutMs = opts.requestTimeoutMs ?? 8000;
    const sleepOp = opts.sleepOp ?? sleep;
    const fetchImpl = opts.fetchImpl ?? fetch;
    const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;

    const scope = yield* useScope();
    const pacer = yield* useRequestPacer({
      baseMs: paceBaseMs,
      jitterMs: paceJitterMs,
      sleepOp,
    });
    const breaker = createBreaker(breakerThreshold, breakerCooldownMs);

    type PrimaryOutcome = SearchResult[] | "soft-fail" | "hard-fail";

  function* doDdg(query: string, max: number): Operation<PrimaryOutcome> {
    yield* pacer.acquire();
    let res: HttpResult;
    try {
      res = yield* fetchWithTimeout(
        DDG_URL,
        {
          method: "POST",
          headers: {
            "User-Agent": userAgent,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ q: query }).toString(),
        },
        requestTimeoutMs,
        fetchImpl,
        sleepOp,
      );
    } catch {
      return "hard-fail";
    }
    if (res.status === 403 || res.status === 429) return "hard-fail";
    if (res.status < 200 || res.status >= 300) return "hard-fail";
    const parsed = parseDdgHtml(res.text);
    if (parsed.length === 0) return "soft-fail";
    return parsed.slice(0, max);
  }

  function* doMarginalia(query: string, max: number): Operation<SearchResult[]> {
    const url = `${MARGINALIA_URL}?query=${encodeURIComponent(query)}&count=${Math.min(Math.max(max, 1), 100)}`;
    let res: HttpResult;
    try {
      res = yield* fetchWithTimeout(
        url,
        { headers: { "API-Key": "public" } },
        requestTimeoutMs,
        fetchImpl,
        sleepOp,
      );
    } catch {
      return [];
    }
    if (res.status === 503 || res.status === 429) return []; // shared-key saturation = soft-empty
    if (res.status < 200 || res.status >= 300) return [];
    return parseMarginaliaJson(res.text);
  }

  function postProcess(results: SearchResult[], max: number): SearchResult[] {
    const cleaned: SearchResult[] = [];
    for (const r of results) {
      const url = normalizeUrl(r.url);
      if (!url) continue;
      cleaned.push({ title: r.title, url, snippet: r.snippet });
    }
    return dedupResults(cleaned).slice(0, max);
  }

    const provider: SearchProvider = {
      returnsFullContentMarkdown: false,
      search(query: string, maxResults: number): Promise<SearchResult[]> {
        const q = query.trim();
        if (!q) return Promise.resolve([]);
        return scope.run(function* () {
          let primary: PrimaryOutcome = "hard-fail";
          if (breaker.canProceed()) {
            primary = yield* doDdg(q, maxResults);
            if (primary === "hard-fail") {
              breaker.onHardFailure();
            } else if (Array.isArray(primary)) {
              breaker.onSuccess();
            }
            // soft-fail: breaker state unchanged (neutral)
          }
          if (Array.isArray(primary)) return postProcess(primary, maxResults);
          const fallback = yield* doMarginalia(q, maxResults);
          return postProcess(fallback, maxResults);
        });
      },
    };

    yield* provide(provider);
  });
}
