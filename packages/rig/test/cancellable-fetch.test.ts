/**
 * Tests for {@link cancellableFetch} — RFC §5.8.
 *
 * Three behaviors verified:
 *
 * 1. Happy path — successful fetch returns the `Response`; the fetch
 *    receives a non-null `AbortSignal` from the Effection scope.
 * 2. Timeout — when `timeoutMs` elapses before the fetch resolves, a
 *    {@link FetchTimeoutError} is thrown AND the in-flight fetch's
 *    `AbortSignal` is aborted (the socket is genuinely cancelled, not
 *    abandoned to complete in the background).
 * 3. Outer-scope halt — when the surrounding Effection scope is
 *    destroyed mid-fetch, the in-flight `AbortSignal` is aborted.
 *
 * The signal-abort assertion is the load-bearing one: it's what
 * distinguishes the new primitive from the legacy `fetch-page.ts` raw
 * `AbortController + setTimeout` pattern. Pre-cancellableFetch, a halted
 * Effection scope rejected the call's promise but left the underlying
 * socket open.
 *
 * @category Testing
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { run, createScope, suspend } from 'effection';
import type { Operation } from 'effection';
import { createServer, type Server } from 'node:http';
import { cancellableFetch, FetchTimeoutError } from '../src/cancellable-fetch';

// ── Fetch recorder ───────────────────────────────────────────────

interface FetchRecorder {
  impl: typeof fetch;
  calls: Array<{
    url: string;
    init: RequestInit;
    signal: AbortSignal | undefined;
    /**
     * Snapshot of `signal.aborted` *at the moment fetch was invoked*.
     * Checking `signal.aborted` after `run()` resolves observes
     * post-scope-teardown state — `useAbortSignal` aborts on scope exit
     * even on successful completion. This snapshot captures the
     * in-flight state.
     */
    signalAbortedAtCall: boolean;
  }>;
}

function makeFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
): FetchRecorder {
  const calls: FetchRecorder['calls'] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    const signal = init.signal as AbortSignal | undefined;
    calls.push({
      url,
      init,
      signal,
      signalAbortedAtCall: signal?.aborted ?? false,
    });
    return handler(url, init);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

// ── Happy path ───────────────────────────────────────────────────

describe('cancellableFetch happy path', () => {
  it('returns the Response when fetch resolves', async () => {
    const recorder = makeFetch(() => new Response('hello', { status: 200 }));
    const result = await run(function* () {
      const res = yield* cancellableFetch('https://example.com', undefined, {
        fetchImpl: recorder.impl,
      });
      return { status: res.status, text: yield* awaitText(res) };
    });
    expect(result.status).toBe(200);
    expect(result.text).toBe('hello');
    expect(recorder.calls.length).toBe(1);
  });

  it('passes a non-aborted Effection-scope-linked AbortSignal to the underlying fetch', async () => {
    const recorder = makeFetch(() => new Response('ok', { status: 200 }));
    await run(function* () {
      yield* cancellableFetch('https://example.com', undefined, {
        fetchImpl: recorder.impl,
      });
    });
    // Signal is an AbortSignal and was NOT aborted at the moment fetch
    // was invoked. (Post-`run()`, the signal has been aborted by scope
    // teardown — `useAbortSignal` fires on scope exit even on success.
    // We check `signalAbortedAtCall` to observe the in-flight state.)
    expect(recorder.calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(recorder.calls[0].signalAbortedAtCall).toBe(false);
  });

  it('strips a caller-supplied signal in favor of the Effection-scope signal', async () => {
    const recorder = makeFetch(() => new Response('ok', { status: 200 }));
    const callerController = new AbortController();
    await run(function* () {
      yield* cancellableFetch('https://example.com', { signal: callerController.signal }, {
        fetchImpl: recorder.impl,
      });
    });
    // The Effection signal replaces the caller's; aborting the caller's
    // controller AFTER the fetch returned has no effect (which we can't
    // really assert without an in-flight call). The behavior we can
    // assert: the recorded signal is NOT the caller's identity.
    expect(recorder.calls[0].signal).not.toBe(callerController.signal);
    expect(recorder.calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('honors RequestInit fields other than signal', async () => {
    const recorder = makeFetch(() => new Response('ok', { status: 200 }));
    await run(function* () {
      yield* cancellableFetch(
        'https://example.com',
        { method: 'POST', headers: { 'X-Test': 'yes' }, body: 'payload' },
        { fetchImpl: recorder.impl },
      );
    });
    expect(recorder.calls[0].init.method).toBe('POST');
    expect(recorder.calls[0].init.headers).toEqual({ 'X-Test': 'yes' });
    expect(recorder.calls[0].init.body).toBe('payload');
  });
});

// ── Timeout ──────────────────────────────────────────────────────

describe('cancellableFetch timeout', () => {
  it('throws FetchTimeoutError when timeoutMs elapses before fetch resolves', async () => {
    const recorder = makeFetch(
      () =>
        // Fetch never resolves on its own — only the timeout can win.
        new Promise<Response>(() => {
          /* never resolves */
        }),
    );

    await expect(
      run(function* () {
        yield* cancellableFetch('https://slow.example.com', undefined, {
          fetchImpl: recorder.impl,
          timeoutMs: 30,
        });
      }),
    ).rejects.toThrow(FetchTimeoutError);
  });

  it('aborts the in-flight fetch signal when the timeout wins', async () => {
    const recorder = makeFetch(
      () =>
        new Promise<Response>(() => {
          /* never resolves */
        }),
    );

    await expect(
      run(function* () {
        yield* cancellableFetch('https://slow.example.com', undefined, {
          fetchImpl: recorder.impl,
          timeoutMs: 30,
        });
      }),
    ).rejects.toThrow(FetchTimeoutError);

    // The load-bearing assertion: the abort signal that was passed to
    // the underlying fetch fired when the timeout won. Pre-fix
    // (fetch-page.ts:152-170 pattern), the AbortController lived in the
    // async closure and a halted scope didn't propagate the abort.
    expect(recorder.calls[0].signal!.aborted).toBe(true);
  });

  it('uses the default 30s timeout when opts.timeoutMs is unset', async () => {
    const recorder = makeFetch(() => new Response('fast', { status: 200 }));
    const result = await run(function* () {
      return yield* cancellableFetch('https://fast.example.com', undefined, {
        fetchImpl: recorder.impl,
      });
    });
    // We can't easily assert the default-timeout *value* without slowing
    // the test, but we can assert the call completed (default didn't
    // crash, didn't fire on a fast response).
    expect(result.status).toBe(200);
  });
});

// ── Live-server body consumption (scope-signal-abort regression) ──
//
// Reproduces the bug observed against apps.lloyal.ai/v1/catalog.json:
// after cancellableFetch resolved, the caller's response.text() threw
// AbortError mid-flight because the http leg's useAbortSignal()-bound
// signal aborted on scope unwind, and undici's consumeBody() rejects
// signal-bound bodies whose signal is already aborted. Synthetic
// `new Response('hello')` mocks DO NOT repro this — they have no
// associated signal — which is why the pre-fix code passed every unit
// test while failing in production.

describe('cancellableFetch live-server body consumption', () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hello: 'from live server' }));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    url = `http://127.0.0.1:${port}/`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('regression: response.text() works after cancellableFetch returns', async () => {
    const text = await run(function* () {
      const res = yield* cancellableFetch(url);
      // The pre-fix code threw AbortError here.
      return yield* call(() => res.text());
    });
    expect(text).toBe('{"hello":"from live server"}');
  });

  it('regression: response.json() works after cancellableFetch returns', async () => {
    const body = await run(function* () {
      const res = yield* cancellableFetch(url);
      return yield* call(() => res.json() as Promise<{ hello: string }>);
    });
    expect(body).toEqual({ hello: 'from live server' });
  });

  it('regression: response.arrayBuffer() works after cancellableFetch returns', async () => {
    const bytes = await run(function* () {
      const res = yield* cancellableFetch(url);
      return yield* call(async () => new Uint8Array(await res.arrayBuffer()));
    });
    expect(new TextDecoder().decode(bytes)).toBe('{"hello":"from live server"}');
  });

  it('preserves response status + headers on the buffered Response', async () => {
    const probe = await run(function* () {
      const res = yield* cancellableFetch(url);
      return {
        status: res.status,
        contentType: res.headers.get('content-type'),
      };
    });
    expect(probe.status).toBe(200);
    expect(probe.contentType).toMatch(/^application\/json/);
  });
});

// ── Outer-scope cancellation ─────────────────────────────────────

describe('cancellableFetch scope cancellation', () => {
  it('aborts the in-flight fetch signal when the outer scope is destroyed', async () => {
    const recorder = makeFetch(
      () =>
        new Promise<Response>(() => {
          /* never resolves */
        }),
    );

    const [scope, destroy] = createScope();
    let recordedSignal: AbortSignal | undefined;

    // Start the fetch inside the scope; it will suspend forever (mock
    // fetch never resolves and we set a huge timeout so the timer doesn't
    // fire first).
    const opPromise = scope.run(function* () {
      // Race against suspend() to keep the operation alive while the
      // fetch is in-flight; we expect the destroy() to halt this and
      // abort the signal.
      const fetchOp = function* (): Operation<Response> {
        return yield* cancellableFetch('https://hanging.example.com', undefined, {
          fetchImpl: recorder.impl,
          timeoutMs: 60_000, // long enough that timeout doesn't fire
        });
      };
      // Race fetch against a suspend that never resolves — fetch should
      // win (or be cancelled). We just need the fetch in flight so the
      // signal is captured.
      return yield* fetchOp();
    });

    // Wait for fetch to have been called (one tick + the async iife).
    // Spin briefly until the call is recorded.
    for (let i = 0; i < 50; i++) {
      if (recorder.calls.length > 0) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(recorder.calls.length).toBe(1);
    recordedSignal = recorder.calls[0].signal;
    expect(recordedSignal!.aborted).toBe(false);

    // Destroy the scope; this should halt the operation and abort the
    // in-flight fetch signal via useAbortSignal's teardown.
    await destroy();
    expect(recordedSignal!.aborted).toBe(true);

    // The scope.run promise should reject with a halt error or similar
    // — we don't pin the exact error type, just that it didn't resolve
    // successfully. Drain to avoid unhandled-rejection warnings.
    await opPromise.catch(() => {
      /* expected */
    });
  });
});

// ── Helpers ──────────────────────────────────────────────────────

import { call } from 'effection';

function* awaitText(res: Response): Operation<string> {
  return yield* call(() => res.text());
}

// suppress unused-import lint for `suspend` (kept for future scope-halt
// tests that need to hold the scope alive longer than the current
// destroy-immediate case).
void suspend;
