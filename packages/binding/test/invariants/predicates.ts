/**
 * Named structural invariants for the bidirectional transports — the
 * binding-package analogue of `packages/agents/test/invariants/predicates.ts`.
 *
 * Each `Bn_*(run): PredicateResult` consumes a `TransportRun` (see `harness.ts`)
 * and returns `{ ok, violations }`. These encode the guarantees the transport
 * source comments claim — bootstrap ordering, no-send/dispatch-after-close, the
 * subscriber never leaks, a sink failure is always swallowed — so a regression
 * that reintroduces any of them fails a machine check.
 */

import type { TransportRun } from "./harness";

export interface Violation {
  invariant: string;
  detail: string;
}

export interface PredicateResult {
  ok: boolean;
  violations: Violation[];
}

function ok(): PredicateResult {
  return { ok: true, violations: [] };
}
function fail(invariant: string, detail: string): PredicateResult {
  return { ok: false, violations: [{ invariant, detail }] };
}

/** Human-readable one-liner for a failing predicate (used in property counter-examples). */
export function formatResult(r: PredicateResult): string {
  return r.violations.map((v) => `[${v.invariant}] ${v.detail}`).join("; ");
}

/**
 * B1 Bootstrap-then-ready: a bidirectional transport emits **all** bootstrap
 * events (as `event` frames) before its single trailing `ready`. Consumers rely
 * on `ready` meaning "bootstrap is fully seeded".
 */
export function B1_bootstrapThenReady(run: TransportRun): PredicateResult {
  const readyIdx = run.out.findIndex((f) => f.t === "ready");
  if (readyIdx === -1) return fail("B1", "no ready frame was ever emitted");
  const eventsBeforeReady = run.out
    .slice(0, readyIdx)
    .filter((f) => f.t === "event").length;
  if (eventsBeforeReady < run.bootstrapCount) {
    return fail(
      "B1",
      `only ${eventsBeforeReady} of ${run.bootstrapCount} bootstrap events emitted before ready`,
    );
  }
  return ok();
}

/** B2 Ready-exactly-once: exactly one `ready` frame is emitted, ever. */
export function B2_readyExactlyOnce(run: TransportRun): PredicateResult {
  const n = run.out.filter((f) => f.t === "ready").length;
  return n === 1 ? ok() : fail("B2", `expected exactly one ready frame, got ${n}`);
}

/**
 * B3 No-send-after-close: once the connection tears down, no further frame is
 * emitted outward — a late `bus.send` must be dropped, not routed to a dead sink.
 */
export function B3_noSendAfterClose(run: TransportRun): PredicateResult {
  if (!run.teardownOccurred) return ok();
  if (run.out.length !== run.outLenAtTeardown) {
    return fail(
      "B3",
      `${run.out.length - run.outLenAtTeardown} frame(s) emitted after teardown`,
    );
  }
  return ok();
}

/**
 * B4 Subscriber-never-leaks: after the run's final teardown the transport has
 * detached from the bus (0 live subscribers). Covers BOTH close-time and
 * sink-failure-time detach — including the drain-window failure where `unsub`
 * isn't assigned yet.
 */
export function B4_subscriberDetached(run: TransportRun): PredicateResult {
  return run.finalSubscriberCount === 0
    ? ok()
    : fail(
        "B4",
        `${run.finalSubscriberCount} bus subscriber(s) still attached after teardown (dead-subscriber leak)`,
      );
}

/**
 * B5 Sink-failure-swallowed: a throwing outbound sink (EPIPE / dead socket)
 * never propagates out of the transport to crash the harness process.
 */
export function B5_sinkFailureSwallowed(run: TransportRun): PredicateResult {
  return run.threw
    ? fail("B5", "a boundary operation threw instead of being swallowed")
    : ok();
}

/**
 * B6 No-dispatch-after-close: once torn down, an inbound command is dropped —
 * no half-open dispatch to a harness whose loop is unwinding.
 */
export function B6_noDispatchAfterClose(run: TransportRun): PredicateResult {
  if (!run.teardownOccurred) return ok();
  if (run.dispatched.length !== run.dispatchedLenAtTeardown) {
    return fail(
      "B6",
      `${run.dispatched.length - run.dispatchedLenAtTeardown} command(s) dispatched after teardown`,
    );
  }
  return ok();
}

/** The full battery — every bidirectional transport must satisfy all of these. */
export const ALL_PREDICATES = [
  B1_bootstrapThenReady,
  B2_readyExactlyOnce,
  B3_noSendAfterClose,
  B4_subscriberDetached,
  B5_sinkFailureSwallowed,
  B6_noDispatchAfterClose,
] as const;

/** Run the whole battery; returns the merged violation list (empty ⇒ all hold). */
export function checkAll(run: TransportRun): Violation[] {
  return ALL_PREDICATES.flatMap((p) => p(run).violations);
}
