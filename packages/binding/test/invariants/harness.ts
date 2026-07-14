/**
 * Transport-invariant harness — the binding-package analogue of
 * `packages/agents/test/invariants/harness.ts`.
 *
 * `driveScript(probe, script, bootstrap)` attaches a bidirectional transport
 * (`ipc`, `wss`, …) to an instrumented `EventBus`, replays a scripted sequence of
 * harness events / inbound commands / sink-failures / teardown, and returns a
 * `TransportRun` capturing everything that crossed the boundary. Named predicates
 * (`predicates.ts`) consume a `TransportRun` and assert the structural guarantees
 * the transports document — so a regression that reintroduces a send-after-close,
 * a dead-subscriber leak, or an unswallowed sink failure fails a machine check,
 * not just developer discipline.
 *
 * The transports differ in signature (`wss` takes an explicit socket; `ipc` reads
 * `process.parentPort`), so each is wrapped in a uniform `ProbeAdapter` whose
 * outbound frames are normalized to the bare `OutFrame` (the wss routing wrapper's
 * `sessionId` is stripped) — the run-plane frame is what these invariants govern.
 */

import { createBus, type EventBus } from "../../src/index";
import { ipc, wss, type WsServerSocket } from "../../src/node";

/** A normalized outbound frame as seen leaving the transport (sessionId stripped). */
export interface OutFrame {
  t: string;
  payload?: unknown;
}

/** One replayable step against an attached transport. */
export type Step =
  | { kind: "event"; payload: unknown } // the harness emits an event down the bus
  | { kind: "command"; payload: unknown } // the remote peer sends a command up
  | { kind: "failSink" } // the outbound sink starts throwing (EPIPE / dead socket)
  | { kind: "teardown" }; // the connection tears down (socket close / disconnect)

export interface TransportRun {
  /** every frame the transport emitted outward, in order (bootstrap events, ready, live). */
  out: OutFrame[];
  /** every command delivered inbound to the harness. */
  dispatched: unknown[];
  /** did any operation throw OUT of the transport (a crash the sink guard should have swallowed)? */
  threw: boolean;
  /** did a teardown step run, and the out/dispatch counts at that instant. */
  teardownOccurred: boolean;
  outLenAtTeardown: number;
  dispatchedLenAtTeardown: number;
  /** how many bootstrap events were seeded. */
  bootstrapCount: number;
  /** leak proxy: bus subscribers still attached after the run's final teardown (must be 0). */
  finalSubscriberCount: number;
}

/** Environment the harness hands a probe when it attaches a transport. */
export interface ProbeEnv {
  bus: EventBus<unknown>;
  bootstrap: unknown[];
  onOut: (frame: OutFrame) => void;
  onDispatch: (command: unknown) => void;
  /** when `.fail` flips true, the probe's outbound sink must throw. */
  failFlag: { fail: boolean };
}

export interface ProbeHandle {
  /** deliver an inbound command frame as the remote peer would. */
  injectCommand: (payload: unknown) => void;
  /** tear the connection down (socket close / parent disconnect / disposer). */
  teardown: () => void;
  /** restore any global state the probe mutated (e.g. `process.parentPort`). */
  cleanup?: () => void;
}

export interface ProbeAdapter {
  name: string;
  start(env: ProbeEnv): ProbeHandle;
}

/** A `createBus` wrapper that preserves the real replay-drain semantics while
 *  exposing a live subscriber count — the leak proxy the predicates read. */
function instrumentedBus(): { bus: EventBus<unknown>; count: () => number } {
  const inner = createBus<unknown>();
  let count = 0;
  return {
    bus: {
      send: (e) => inner.send(e),
      subscribe: (h) => {
        count++;
        const off = inner.subscribe(h);
        // Idempotent like the real bus (subscribers.delete no-ops on repeat) —
        // the transports legitimately call their disposer more than once
        // (catch + post-drain re-check, teardown + finally). Decrement once.
        let detached = false;
        return () => {
          if (!detached) {
            detached = true;
            count--;
          }
          off();
        };
      },
    },
    count: () => count,
  };
}

/** Replay `script` against `probe` and capture the boundary behavior. Always
 *  force-tears-down in a `finally` so no probe leaks a timer/listener/global. */
export function driveScript(
  probe: ProbeAdapter,
  script: Step[],
  bootstrap: unknown[] = [],
): TransportRun {
  const { bus, count } = instrumentedBus();
  const out: OutFrame[] = [];
  const dispatched: unknown[] = [];
  const failFlag = { fail: false };
  let threw = false;
  let teardownOccurred = false;
  let outLenAtTeardown = 0;
  let dispatchedLenAtTeardown = 0;

  const markTeardown = (): void => {
    if (teardownOccurred) return;
    teardownOccurred = true;
    outLenAtTeardown = out.length;
    dispatchedLenAtTeardown = dispatched.length;
  };

  let handle: ProbeHandle | undefined;
  try {
    handle = probe.start({
      bus,
      bootstrap,
      onOut: (f) => out.push(f),
      onDispatch: (c) => dispatched.push(c),
      failFlag,
    });

    for (const step of script) {
      try {
        switch (step.kind) {
          case "event":
            bus.send(step.payload);
            break;
          case "command":
            handle.injectCommand(step.payload);
            break;
          case "failSink":
            failFlag.fail = true;
            break;
          case "teardown":
            markTeardown();
            handle.teardown();
            break;
        }
      } catch {
        threw = true; // a boundary op crashed instead of being swallowed
      }
    }
  } finally {
    // Force teardown + global restore regardless of the script (idempotent).
    try {
      handle?.teardown();
    } catch {
      threw = true;
    }
    handle?.cleanup?.();
  }

  return {
    out,
    dispatched,
    threw,
    teardownOccurred,
    outLenAtTeardown,
    dispatchedLenAtTeardown,
    bootstrapCount: bootstrap.length,
    finalSubscriberCount: count(),
  };
}

// ── Probes ─────────────────────────────────────────────────────────

/** The `wss` server transport — pure (explicit socket, no globals). */
export const wssProbe: ProbeAdapter = {
  name: "wss",
  start({ bus, bootstrap, onOut, onDispatch, failFlag }) {
    let msgCb: ((data: unknown) => void) | undefined;
    let closeCb: (() => void) | undefined;
    const socket: WsServerSocket = {
      send: (data: string) => {
        if (failFlag.fail) throw new Error("wss socket dead");
        const routed = JSON.parse(data) as { frame: OutFrame };
        onOut(routed.frame); // strip the sessionId wrapper — govern the run-plane frame
      },
      on: (event: "message" | "close", cb: (...a: never[]) => void) => {
        if (event === "message") msgCb = cb as (data: unknown) => void;
        else closeCb = cb as () => void;
      },
    };
    wss(socket, {
      uiChannel: bus,
      dispatch: onDispatch,
      bootstrap,
      sessionId: "probe",
    });
    return {
      injectCommand: (payload) =>
        msgCb?.(
          JSON.stringify({ sessionId: "probe", frame: { t: "command", payload } }),
        ),
      teardown: () => closeCb?.(),
    };
  },
};

/** The `ipc` bridge transport — mutates `process.parentPort`; restores it on cleanup. */
export const ipcProbe: ProbeAdapter = {
  name: "ipc",
  start({ bus, bootstrap, onOut, onDispatch, failFlag }) {
    let msgCb: ((e: { data: unknown }) => void) | undefined;
    const holder = process as unknown as { parentPort?: unknown };
    const prev = holder.parentPort;
    holder.parentPort = {
      postMessage: (m: OutFrame) => {
        if (failFlag.fail) throw new Error("ipc channel dead");
        onOut(m); // ipc posts the bare BindingFrame already
      },
      on: (_e: "message", cb: (e: { data: unknown }) => void) => {
        msgCb = cb;
      },
      off: () => {},
      start: () => {},
    };
    const dispose = ipc<unknown, unknown>()(bus, onDispatch, bootstrap);
    return {
      injectCommand: (payload) => msgCb?.({ data: { t: "command", payload } }),
      teardown: dispose,
      cleanup: () => {
        holder.parentPort = prev;
      },
    };
  },
};
