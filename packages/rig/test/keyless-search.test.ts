import { describe, it, expect, vi } from "vitest";
import { run, action, createScope, suspend } from "effection";
import type { Operation } from "effection";
import {
  createKeylessSearchProvider,
  type KeylessSearchOptions,
} from "../src/tools/keyless-search";
import type { SearchProvider } from "../src/tools/types";

/**
 * Effection-driven tests for the keyless SearchProvider.
 *
 * Two modes:
 *
 * - **Real-sleep tests** (most): tiny `paceBaseMs` (5ms) + real Effection
 *   `sleep`. Mock `fetch` resolves synchronously so the timeout race never
 *   fires; pacer adds at most ~5ms wait per search. Used for parse, breaker,
 *   normalize, fallback, score-absence assertions.
 *
 * - **Manual-clock tests** (pacer + timeout): inject a tick-queued `sleepOp`
 *   so we can control time precisely. Used to assert FIFO release ordering
 *   under concurrency, that the timeout actually aborts the in-flight fetch
 *   (not just abandons it), and that the pacer producer is torn down with
 *   its owning scope.
 */

// ─── Manual clock ──────────────────────────────────────────────────

interface ManualClock {
  sleepOp: (ms: number) => Operation<void>;
  /** Fire the first pending sleep matching the predicate (or the head). */
  fire(pred?: (ms: number) => boolean): boolean;
  /** Fire pending sleeps in order, awaiting microtasks between fires so
   *  continuations have a chance to enqueue new sleeps. Bounded against runaway. */
  flushAll(): Promise<number>;
  size(): number;
  msValues(): number[];
}

function createManualClock(): ManualClock {
  const pending: Array<{ ms: number; fire: () => void }> = [];
  const sleepOp = (ms: number): Operation<void> =>
    action<void>((resolve) => {
      const entry = { ms, fire: () => resolve() };
      pending.push(entry);
      return () => {
        const i = pending.indexOf(entry);
        if (i >= 0) pending.splice(i, 1);
      };
    });
  return {
    sleepOp,
    fire(pred): boolean {
      const i = pred ? pending.findIndex((p) => pred(p.ms)) : 0;
      if (i < 0 || pending.length === 0) return false;
      const entry = pending.splice(i, 1)[0];
      entry.fire();
      return true;
    },
    async flushAll(): Promise<number> {
      let n = 0;
      for (let i = 0; i < 200; i++) {
        if (pending.length === 0) {
          await Promise.resolve();
          if (pending.length === 0) break;
        }
        const entry = pending.shift()!;
        entry.fire();
        n++;
        await Promise.resolve();
      }
      return n;
    },
    size(): number {
      return pending.length;
    },
    msValues(): number[] {
      return pending.map((p) => p.ms);
    },
  };
}

// ─── Fetch recorder ────────────────────────────────────────────────

interface FetchRecorder {
  impl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit; signal: AbortSignal | undefined }>;
}

function makeFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
): FetchRecorder {
  const calls: FetchRecorder["calls"] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const signal = init.signal as AbortSignal | undefined;
    calls.push({ url, init, signal });
    return handler(url, init);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function htmlResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html" },
  });
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SAMPLE_DDG_HTML = (extra = ""): string => {
  // Padded to clear the >200-char soft-block threshold.
  const filler = "<!--padding".padEnd(220, " ") + "-->";
  return `${filler}
    <div class="result results_links">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="https://example.com/one">First Result Title</a>
      </h2>
      <a class="result__snippet" href="https://example.com/one">First <b>snippet</b> body text.</a>
    </div>
    <div class="result results_links">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="https://blog.example.org/two">Second Result Title</a>
      </h2>
      <a class="result__snippet" href="https://blog.example.org/two">Second snippet body &amp; text.</a>
    </div>
    ${extra}
  `;
};

const SAMPLE_MARGINALIA = {
  license: "CC-BY-NC-SA 4.0",
  page: 1,
  pages: 1,
  query: "x",
  results: [
    {
      url: "https://niche.example/a",
      title: "Niche A",
      description: "Marginalia result A description with    extra   whitespace.",
    },
    {
      url: "https://niche.example/b",
      title: "Niche B",
      description: "Marginalia result B description.",
    },
  ],
};

// ─── withProvider helper ────────────────────────────────────────────

/**
 * Build a provider inside a scope that stays alive across the test body.
 * The provider's `search()` returns Promises, so most assertions can be done
 * from regular async/await code.
 */
async function withProvider<T>(
  opts: KeylessSearchOptions,
  body: (provider: SearchProvider) => Promise<T>,
): Promise<T> {
  const [scope, destroy] = createScope();
  let providerHandle: SearchProvider | null = null;
  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });

  const lifetime = scope.run(function* () {
    providerHandle = yield* createKeylessSearchProvider(opts);
    resolveReady!();
    yield* suspend();
  });

  try {
    await ready;
    return await body(providerHandle!);
  } finally {
    await destroy();
    await lifetime.catch(() => undefined);
  }
}

// Default options for real-sleep tests. Real `sleep` keeps the pacer/timeout
// race correct; tiny `paceBaseMs` keeps test overhead negligible.
function defaults(over: Partial<KeylessSearchOptions> = {}): KeylessSearchOptions {
  return {
    paceBaseMs: 5,
    paceJitterMs: 0,
    requestTimeoutMs: 5_000,
    breakerThreshold: 2,
    breakerCooldownMs: 15_000,
    ...over,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("createKeylessSearchProvider — construction", () => {
  it("throws when paceBaseMs <= 0 (loud-fail on missing pacer)", async () => {
    await expect(
      run(function* () {
        yield* createKeylessSearchProvider({ paceBaseMs: 0 });
      }),
    ).rejects.toThrow(/unpaced egress/i);
  });

  it("throws when paceJitterMs < 0", async () => {
    await expect(
      run(function* () {
        yield* createKeylessSearchProvider({
          paceBaseMs: 1000,
          paceJitterMs: -1,
        });
      }),
    ).rejects.toThrow(/paceJitterMs/);
  });

  it("exposes returnsFullContentMarkdown: false", async () => {
    const value = await withProvider(defaults(), async (p) => p.returnsFullContentMarkdown);
    expect(value).toBe(false);
  });
});

describe("createKeylessSearchProvider — empty query", () => {
  it("returns [] without issuing a fetch", async () => {
    const fetcher = makeFetch(() => htmlResponse(200, SAMPLE_DDG_HTML()));
    const out = await withProvider(
      defaults({ fetchImpl: fetcher.impl }),
      async (p) => p.search("   ", 5),
    );
    expect(out).toEqual([]);
    expect(fetcher.calls).toHaveLength(0);
  });
});

describe("createKeylessSearchProvider — DDG happy path", () => {
  it("returns parsed results in provider order with no score field", async () => {
    const fetcher = makeFetch(() => htmlResponse(200, SAMPLE_DDG_HTML()));
    const results = await withProvider(
      defaults({ fetchImpl: fetcher.impl }),
      async (p) => p.search("speculative decoding", 8),
    );
    expect(results).toHaveLength(2);
    expect(results[0].url).toBe("https://example.com/one");
    expect(results[0].title).toBe("First Result Title");
    expect(results[0].snippet).toContain("First");
    expect(results[1].url).toBe("https://blog.example.org/two");
    expect(results[1].snippet).toContain("Second snippet body & text");
    for (const r of results) {
      expect("score" in r).toBe(false);
    }
    expect(results.map((r) => r.url)).toEqual([
      "https://example.com/one",
      "https://blog.example.org/two",
    ]);
  });

  it("filters PDF candidates at discovery (dead-slot avoidance)", async () => {
    const html = SAMPLE_DDG_HTML(`
      <div class="result results_links">
        <h2><a rel="nofollow" class="result__a" href="https://docs.example.com/paper.pdf">PDF result</a></h2>
        <a class="result__snippet" href="https://docs.example.com/paper.pdf">pdf snippet</a>
      </div>
    `);
    const fetcher = makeFetch(() => htmlResponse(200, html));
    const results = await withProvider(
      defaults({ fetchImpl: fetcher.impl }),
      async (p) => p.search("x", 8),
    );
    expect(results.map((r) => r.url)).not.toContain(
      "https://docs.example.com/paper.pdf",
    );
  });

  it("strips tracking params and dedupes normalized URLs", async () => {
    const html = SAMPLE_DDG_HTML(`
      <div class="result results_links">
        <a rel="nofollow" class="result__a" href="https://dup.example.com/x?utm_source=ddg&amp;q=1">Tracked</a>
        <a class="result__snippet" href="https://dup.example.com/x">tracked snippet</a>
      </div>
      <div class="result results_links">
        <a rel="nofollow" class="result__a" href="https://dup.example.com/x?q=1">Duplicate</a>
        <a class="result__snippet" href="https://dup.example.com/x">dup snippet</a>
      </div>
    `);
    const fetcher = makeFetch(() => htmlResponse(200, html));
    const results = await withProvider(
      defaults({ fetchImpl: fetcher.impl }),
      async (p) => p.search("x", 8),
    );
    const tracked = results.find((r) =>
      r.url.startsWith("https://dup.example.com/x"),
    );
    expect(tracked?.url).toBe("https://dup.example.com/x?q=1");
    expect(tracked?.url).not.toContain("utm_source");
    const dupCount = results.filter((r) =>
      r.url.startsWith("https://dup.example.com/x"),
    ).length;
    expect(dupCount).toBe(1);
  });
});

describe("createKeylessSearchProvider — fallback engine", () => {
  it("falls back to Marginalia on DDG soft-block (200 + empty body), breaker untouched", async () => {
    const fetcher = makeFetch((url) => {
      if (url.startsWith("https://html.duckduckgo.com")) {
        return htmlResponse(200, "<html><body>nothing here</body></html>");
      }
      return jsonResponse(200, SAMPLE_MARGINALIA);
    });
    await withProvider(defaults({ fetchImpl: fetcher.impl }), async (p) => {
      const r1 = await p.search("first", 8);
      expect(r1.map((r) => r.url)).toEqual([
        "https://niche.example/a",
        "https://niche.example/b",
      ]);
      expect(r1[0].snippet).toBe(
        "Marginalia result A description with extra whitespace.",
      );
      const r2 = await p.search("second", 8);
      expect(r2).toHaveLength(2);
      const ddgCalls = fetcher.calls.filter((c) =>
        c.url.startsWith("https://html.duckduckgo.com"),
      );
      expect(ddgCalls).toHaveLength(2); // soft-empty was neutral; DDG still tried
    });
  });

  it("treats Marginalia 503 as soft-empty (no throw, no breaker impact)", async () => {
    const fetcher = makeFetch((url) => {
      if (url.startsWith("https://html.duckduckgo.com")) {
        return htmlResponse(200, "<empty/>");
      }
      return jsonResponse(503, { error: "saturated" });
    });
    const results = await withProvider(
      defaults({ fetchImpl: fetcher.impl }),
      async (p) => p.search("q", 8),
    );
    expect(results).toEqual([]);
  });
});

describe("createKeylessSearchProvider — breaker", () => {
  it("opens after threshold hard failures and skips DDG until cooldown elapses", async () => {
    let ddgCalls = 0;
    const fetcher = makeFetch((url) => {
      if (url.startsWith("https://html.duckduckgo.com")) {
        ddgCalls++;
        return htmlResponse(429, "");
      }
      return jsonResponse(200, SAMPLE_MARGINALIA);
    });
    await withProvider(
      defaults({
        fetchImpl: fetcher.impl,
        breakerThreshold: 2,
        breakerCooldownMs: 60_000,
      }),
      async (p) => {
        await p.search("q1", 5);
        expect(ddgCalls).toBe(1);
        await p.search("q2", 5);
        expect(ddgCalls).toBe(2);
        await p.search("q3", 5);
        expect(ddgCalls).toBe(2); // breaker open → DDG skipped
      },
    );
  });

  it("recovers via half-open probe after cooldown", async () => {
    let ddgCalls = 0;
    let ddgFailMode = true;
    const fetcher = makeFetch((url) => {
      if (url.startsWith("https://html.duckduckgo.com")) {
        ddgCalls++;
        return ddgFailMode
          ? htmlResponse(429, "")
          : htmlResponse(200, SAMPLE_DDG_HTML());
      }
      return jsonResponse(200, SAMPLE_MARGINALIA);
    });
    await withProvider(
      defaults({
        fetchImpl: fetcher.impl,
        breakerThreshold: 2,
        breakerCooldownMs: 50,
      }),
      async (p) => {
        await p.search("q1", 5);
        await p.search("q2", 5);
        expect(ddgCalls).toBe(2);

        // Wall-clock wait past cooldown (the breaker uses Date.now()).
        await new Promise((r) => setTimeout(r, 80));

        ddgFailMode = false;
        const r = await p.search("q3", 5);
        expect(r.length).toBeGreaterThan(0);
        expect(r[0].url).toBe("https://example.com/one");
        expect(ddgCalls).toBe(3);

        await p.search("q4", 5);
        expect(ddgCalls).toBe(4);
      },
    );
  });
});

describe("createKeylessSearchProvider — timeout cancellation", () => {
  it("aborts the in-flight fetch when the timeout wins (cancel, not abandon)", async () => {
    const clock = createManualClock();
    let observedAborted = false;
    let resolveFetchOuter: ((res: Response) => void) | null = null;
    const fetcher = makeFetch((_url, init) => {
      const signal = init.signal as AbortSignal | undefined;
      return new Promise<Response>((resolve, reject) => {
        resolveFetchOuter = resolve;
        signal?.addEventListener("abort", () => {
          observedAborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const [scope, destroy] = createScope();
    let providerHandle: SearchProvider | null = null;
    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>((r) => {
      resolveReady = r;
    });
    const lifetime = scope.run(function* () {
      providerHandle = yield* createKeylessSearchProvider({
        sleepOp: clock.sleepOp,
        fetchImpl: fetcher.impl,
        paceBaseMs: 100,
        paceJitterMs: 0,
        requestTimeoutMs: 5_000,
      });
      resolveReady!();
      yield* suspend();
    });

    try {
      await ready;
      // Pacer producer scheduled its first 100ms idle tick. Fire it so the
      // FIRST search waiter has a chance to acquire.
      const searchP = providerHandle!.search("q", 5);
      // Wait for the search to register a pacer waiter and the producer to
      // be sleeping (100ms). Microtask flush.
      await Promise.resolve();
      await Promise.resolve();
      // Fire the pacer tick → search gets its slot → fetch begins (hangs).
      expect(clock.fire((ms) => ms === 100)).toBe(true);
      // Settle: race spawns httpLeg + timeoutLeg; timeoutLeg queues 5000ms sleep.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      // Fire the 5000ms timeout → race wins for timeout → httpLeg halted →
      // useAbortSignal aborts → fetch's mocked signal listener fires.
      expect(clock.fire((ms) => ms === 5_000)).toBe(true);

      // Settle the rejection; provider's doDdg catches → "hard-fail" → fallback
      // → Marginalia branch will also fetchWithTimeout (same hanging fetch). To
      // avoid hanging the test, resolve the (now-aborted) primary fetch as a
      // safety net.
      if (resolveFetchOuter) resolveFetchOuter(htmlResponse(503, ""));

      // Fire any subsequent sleeps (Marginalia request timeout etc).
      await clock.flushAll();
      // Tolerate the search resolving to anything; we only assert the abort.
      await searchP.catch(() => undefined);
      expect(observedAborted).toBe(true);
    } finally {
      await destroy();
      await lifetime.catch(() => undefined);
    }
  });
});

describe("createKeylessSearchProvider — pacer", () => {
  it("bounds concurrent DDG egress to one-per-interval (FIFO release order)", async () => {
    const clock = createManualClock();
    const fetchOrder: string[] = [];
    const fetcher = makeFetch(async (url, init) => {
      if (url.startsWith("https://html.duckduckgo.com")) {
        const body = (init.body as string | undefined) ?? "";
        const m = /(?:^|&)q=([^&]+)/.exec(body);
        const q = m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : "?";
        fetchOrder.push(q);
      }
      return htmlResponse(200, SAMPLE_DDG_HTML());
    });

    const [scope, destroy] = createScope();
    let providerHandle: SearchProvider | null = null;
    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>((r) => {
      resolveReady = r;
    });
    const lifetime = scope.run(function* () {
      providerHandle = yield* createKeylessSearchProvider({
        sleepOp: clock.sleepOp,
        fetchImpl: fetcher.impl,
        paceBaseMs: 100,
        paceJitterMs: 0,
      });
      resolveReady!();
      yield* suspend();
    });

    try {
      await ready;

      // Three concurrent searches; pacer must serialize them in FIFO order.
      const p1 = providerHandle!.search("alpha", 1);
      const p2 = providerHandle!.search("beta", 1);
      const p3 = providerHandle!.search("gamma", 1);

      // Allow waiters to register.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchOrder).toEqual([]);

      // Tick #1 → alpha
      expect(clock.fire((ms) => ms === 100)).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchOrder).toEqual(["alpha"]);

      // Tick #2 → beta
      expect(clock.fire((ms) => ms === 100)).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchOrder).toEqual(["alpha", "beta"]);

      // Tick #3 → gamma
      expect(clock.fire((ms) => ms === 100)).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchOrder).toEqual(["alpha", "beta", "gamma"]);

      // Drain remaining ticks (pacer's next idle slot + per-request timeouts).
      await clock.flushAll();
      await Promise.all([p1, p2, p3]);
    } finally {
      await destroy();
      await lifetime.catch(() => undefined);
    }
  });

  it("tears down the pacer producer when its owning scope exits", async () => {
    const clock = createManualClock();
    const fetcher = makeFetch(() => htmlResponse(200, SAMPLE_DDG_HTML()));

    const [scope, destroy] = createScope();
    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>((r) => {
      resolveReady = r;
    });
    const lifetime = scope.run(function* () {
      yield* createKeylessSearchProvider({
        sleepOp: clock.sleepOp,
        fetchImpl: fetcher.impl,
        paceBaseMs: 100,
        paceJitterMs: 0,
      });
      resolveReady!();
      yield* suspend();
    });
    await ready;
    // Settle so the producer's first 100ms sleep gets registered.
    await Promise.resolve();
    await Promise.resolve();
    expect(clock.size()).toBeGreaterThan(0);

    await destroy();
    await lifetime.catch(() => undefined);
    // After destroy, the action() cleanup ran → pending entry removed.
    expect(clock.size()).toBe(0);
  });
});
