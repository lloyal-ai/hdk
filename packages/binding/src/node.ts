/**
 * @lloyal-labs/binding/node — the Node bindings.
 *
 * A *binding* attaches a consumer to a harness's headless interface with **one
 * uniform shape** (`Binding`): given the harness's `EventBus` (events out), a
 * command sink (commands in), and the bootstrap events, it wires them to a
 * transport and returns a disposer. The local adapters live here — `ndjson`
 * (one-way JSON Lines) and `ipc` (the `parentPort`-else-`fork` bridge). `render`
 * (Ink) is app-side and conforms to the same shape; in-process is plain
 * `bus.subscribe` (pub/sub), not a transport. The remote `wss` binding is the
 * server-side superset — it also authors the session plane.
 */

import type {
  EventBus,
  BindingFrame,
  SessionFrame,
  SessionState,
  RoutedBindingFrame,
} from "./index";

/** Tear down a binding: unsubscribe, remove listeners, stop keep-alive. */
export type Dispose = () => void;

/**
 * The uniform binding contract. Every local adapter — `render` (Ink, app-side),
 * `ndjson`, `ipc` — has this shape, so an app threads the same triple into
 * whichever it picks, with no `mode` enum and no in-process special case.
 * Transport *capabilities* differ by boundary (`ndjson` is one-way — no inbound
 * commands, no `ready`), but the attachment/lifecycle *shape* is one.
 */
export type Binding<E, C> = (
  bus: EventBus<E>,
  dispatch: (command: C) => void,
  bootstrap: readonly E[],
) => Dispose;

/**
 * One-way JSON Lines: write each event as a line (default: stdout). No inbound
 * command channel, no `ready`, no envelope — raw events. `dispatch` is never
 * called.
 */
export function ndjson<E, C = never>(
  opts: { out?: (line: string) => void } = {},
): Binding<E, C> {
  const out = opts.out ?? ((line: string) => process.stdout.write(line + "\n"));
  return (bus, _dispatch, bootstrap) => {
    const unsub = bus.subscribe((ev) => out(JSON.stringify(ev)));
    for (const ev of bootstrap) bus.send(ev);
    return unsub;
  };
}

/**
 * The `parentPort`-else-`fork` bridge: full-duplex `BindingFrame` over Electron
 * `parentPort` if present, else a `child_process.fork()` child's IPC channel.
 * Events + a trailing `ready` go down; `command` frames come up.
 */
export function ipc<E, C>(): Binding<E, C> {
  return (bus, dispatch, bootstrap) => {
    const pp = (
      process as unknown as {
        parentPort?: {
          postMessage(m: unknown): void;
          on(e: "message", cb: (ev: { data: unknown }) => void): void;
          off?(e: "message", cb: (ev: { data: unknown }) => void): void;
          removeListener?(
            e: "message",
            cb: (ev: { data: unknown }) => void,
          ): void;
          start?(): void;
        };
      }
    ).parentPort;

    // Needs a real IPC channel: Electron `parentPort`, else a
    // `child_process.fork()` child's `process.send`. Fail fast in a plain Node
    // process rather than a cryptic "process.send is not a function" when the
    // first frame posts.
    if (!pp && typeof process.send !== "function") {
      throw new Error(
        "ipc(): no IPC channel — needs an Electron parentPort or a " +
          "child_process.fork() child (neither process.parentPort nor process.send).",
      );
    }

    const post = (m: BindingFrame<E, C>): void => {
      if (pp) pp.postMessage(m);
      else process.send!(m);
    };
    const onMsg = (m: { t?: string; payload?: unknown }): void => {
      if (m?.t === "command") dispatch(m.payload as C);
    };
    // Named wrapper so the disposer can detach the parentPort listener (Node's
    // MessagePort and Electron's MessagePortMain both alias `off` → removeListener).
    const ppOnMsg = (e: { data: unknown }): void =>
      onMsg(e.data as { t?: string; payload?: unknown });

    if (pp) {
      pp.on("message", ppOnMsg);
      pp.start?.();
    } else {
      process.on("message", onMsg);
    }

    const unsub = bus.subscribe((ev) => post({ t: "event", payload: ev }));

    // No Ink/stdin handle holds the libuv loop open here; keep it alive while the
    // suspended command loop waits.
    const keepAlive = setInterval(() => {}, 1 << 30);
    const stopKeepAlive = (): void => clearInterval(keepAlive);
    process.on("exit", stopKeepAlive);

    // Seed bootstrap through the (already-subscribed) bus, then signal ready.
    for (const ev of bootstrap) bus.send(ev);
    post({ t: "ready" });

    return () => {
      unsub();
      stopKeepAlive();
      process.off("exit", stopKeepAlive);
      // Prefer `off`; fall back to `removeListener` for hosts whose MessagePort
      // exposes only the EventEmitter alias.
      if (pp) (pp.off ?? pp.removeListener)?.call(pp, "message", ppOnMsg);
      else process.off("message", onMsg);
    };
  };
}

/**
 * The minimal server-side WebSocket surface the `wss` binding uses — structurally
 * satisfied by the `ws` library's socket (and Node's global `WebSocket`). The
 * relay/host supplies it, so the binding stays zero-dependency and
 * transport-library-agnostic.
 */
export interface WsServerSocket {
  send(data: string): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
}

export interface WssOpts<E, C> {
  /** the harness's event bus (events flow out of it) */
  uiChannel: EventBus<E>;
  /** called with each inbound command (the app wraps `commands.send`) */
  dispatch: (command: C) => void;
  /** events seeded before `ready` (e.g. config loaded, download plan) */
  bootstrap: E[];
  /**
   * the Session this connection is addressed to. The MVP carries one fixed
   * `sessionId` per connection; carrying it on every frame keeps
   * `connection ≡ Session` out of the protocol.
   */
  sessionId: string;
}

/**
 * The **server-side** `wss` binding — the remote sibling of `ipc`, speaking the
 * run-plane `BindingFrame` over a WebSocket, wrapped per-frame in a
 * `RoutedBindingFrame` (sessionId outside) so the inner envelope is transported
 * unchanged. Called in-process, once per connection (Option B: one call per
 * Session bus; a single-embed self-host: one call total).
 *
 * Unlike the local `Binding` adapters it is a **superset**: it returns
 * `postSession`, because the box gateway authors the session plane (`SessionFrame`,
 * never a `BindingFrame` variant) — the local cuts fix the active Session by
 * construction and have no session plane. The bus auto-detaches on socket close.
 */
export function wss<E, C>(
  socket: WsServerSocket,
  opts: WssOpts<E, C>,
): (state: SessionState) => void {
  const { uiChannel, dispatch, bootstrap, sessionId } = opts;
  const route = (frame: BindingFrame<E, C> | SessionFrame): void => {
    const routed: RoutedBindingFrame<E, C> = { sessionId, frame };
    socket.send(JSON.stringify(routed));
  };

  socket.on("message", (data) => {
    let m: RoutedBindingFrame<E, C>;
    try {
      m = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return; // ignore non-JSON / binary frames
    }
    // MVP: one Session per connection, so inbound commands need no sessionId
    // filter. TODO(multi-session): when N Sessions share a socket, drop frames
    // whose `m.sessionId !== sessionId`.
    if (m?.frame?.t === "command") dispatch(m.frame.payload as C);
  });

  const unsubscribe = uiChannel.subscribe((ev) =>
    route({ t: "event", payload: ev }),
  );
  socket.on("close", unsubscribe);

  // Seed bootstrap through the (already-subscribed) bus, then signal ready.
  for (const ev of bootstrap) uiChannel.send(ev);
  route({ t: "ready" });

  // The gateway authors the session plane; posting wraps it as a SessionFrame.
  return (state: SessionState) => route({ t: "session", payload: state });
}
