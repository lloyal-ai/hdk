/**
 * @lloyal-labs/binding/web — the browser side of the `wss` transport.
 *
 * A pure `event → handler` sink plus a command up-channel over one WebSocket —
 * the browser sibling of the server-side `wss` binding, speaking the same
 * `BindingFrame`. Zero-
 * dependency and DOM-lib-free: it declares only the minimal structural WebSocket
 * surface it uses, so the app's bundler supplies the real browser global.
 *
 * Stateless — no seq/reconnect replay; durability is a deferred, separate
 * concern. On a dropped socket the client reports `onClose`; the app decides
 * whether to reconnect.
 */

import type { RoutedBindingFrame, SessionState } from "./index";
import type { Bridge, Frame, Snapshot, WireStatus } from "./projection";

/** The minimal browser WebSocket surface the client uses (structural). */
interface BrowserWebSocket {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "message",
    listener: (ev: { data: unknown }) => void,
  ): void;
  addEventListener(type: "close", listener: () => void): void;
}

export interface WssClientHandlers<E> {
  /** a run-plane event (opaque to the binding) */
  onEvent: (event: E) => void;
  /** the client-visible Session lifecycle (queued / warming / live / died / …) */
  onSession?: (state: SessionState) => void;
  /** the harness finished bootstrap and is ready */
  onReady?: () => void;
  /** the socket closed */
  onClose?: () => void;
}

export interface WssClient<C> {
  /** send a command up to the harness */
  send(command: C): void;
  /** close the connection */
  close(): void;
}

/**
 * Open a `wss` connection to a lloyal-anchor / framework-relay and route inbound
 * `BindingFrame`s to handlers. The command up-channel mirrors the harness's local
 * cuts: `send(command)` posts a `{ t:"command" }` frame.
 */
export function connectWss<E, C>(
  url: string,
  handlers: WssClientHandlers<E>,
): WssClient<C> {
  // DOM-lib-free: read the WebSocket constructor off `globalThis` with a narrow
  // cast (no global `declare`, so nothing to clash with a consumer's lib.dom).
  // Portable — browsers, Deno, Bun, and Node >=21 all expose a global WebSocket;
  // fail fast where none exists instead of a cryptic ReferenceError.
  const WebSocketCtor = (
    globalThis as unknown as {
      WebSocket?: new (url: string) => BrowserWebSocket;
    }
  ).WebSocket;
  if (!WebSocketCtor) {
    throw new Error(
      "connectWss needs a global WebSocket (browsers, Deno, Bun, Node >=21). " +
        "None found in this runtime; on the server use the node entry's wss() instead.",
    );
  }
  const ws = new WebSocketCtor(url);
  // The server addresses every frame with a `sessionId`; capture the last-seen
  // one so the command up-channel echoes it (the MVP has one fixed id).
  let sessionId = "";
  let closed = false; // stop send()ing once the socket is gone

  ws.addEventListener("message", (ev) => {
    let m: RoutedBindingFrame<E, C>;
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return; // ignore non-JSON frames
    }
    if (typeof m.sessionId === "string") sessionId = m.sessionId;
    const frame = m.frame;
    // Malformed-but-valid-JSON message: guard before branching on `t` so a bad
    // frame can't throw and kill the handler loop.
    if (!frame || typeof frame.t !== "string") return;
    if (frame.t === "event") handlers.onEvent(frame.payload);
    else if (frame.t === "session") handlers.onSession?.(frame.payload);
    else if (frame.t === "ready") handlers.onReady?.();
  });
  ws.addEventListener("close", () => {
    closed = true;
    handlers.onClose?.();
  });

  return {
    send(command: C): void {
      if (closed) return; // socket gone — dropping is the stateless contract
      // In the MVP `sessionId` may still be "" if send() precedes the first
      // inbound frame — harmless, the server ignores inbound sessionId (one
      // Session per connection). TODO(multi-session): fail-fast on "" once the
      // server routes commands by sessionId.
      const routed: RoutedBindingFrame<E, C> = {
        sessionId,
        frame: { t: "command", payload: command },
      };
      try {
        ws.send(JSON.stringify(routed));
      } catch {
        closed = true; // socket closing mid-send
      }
    },
    close(): void {
      ws.close();
    },
  };
}

export interface CreateBridgeOpts<E, S> {
  /** The view's fold, seeded with `initialState`: the bridge folds every event
   *  it delivers, so a late subscriber's snapshot is what the stream folded to. */
  initialState: S;
  reduce: (state: S, ev: E) => S;
  /** The content plane's origin, when this host serves one. `""` is a
   *  same-origin plane (a dev proxy); absent means no plane. */
  contentOrigin?: string;
  /** Called with the client-visible Session lifecycle the host relays. */
  onSession?: (state: SessionState) => void;
  /** How this page gets a working session. A served host has no way to re-admit an existing
   *  connection, so it is a new one — which this module cannot start for itself, being
   *  DOM-lib-free; the app supplies it (typically reloading the page). */
  recover?: () => void;
}

/**
 * The browser's bridge over one `wss` connection — what a view holds. It owns a
 * fold: every event is numbered (`seq`, within this connection's `epoch`) and
 * folded before it reaches a subscriber, so `requestSnapshot` answers from the
 * fold and a view that mounts after the stream began — a remount, a late
 * component — seeds correctly, with no history kept and no cap to fall off.
 * Commands queue until the host says ready. The socket's fate is the wire's
 * status: 'connecting' until ready, 'connected' after, 'lost' when it closes.
 */
export function createBridge<E, C, S>(url: string, opts: CreateBridgeOpts<E, S>): Bridge<E, C, S> & { close(): void } {
  const epoch = Date.now();
  let seq = 0;
  let state = opts.initialState;
  let status: WireStatus = "connecting";
  let ready = false;
  let queued: C[] = [];
  const frameListeners = new Set<(frame: Frame<E>) => void>();
  const statusListeners = new Set<(status: WireStatus) => void>();
  // The host's word on this session. Held here rather than handed straight past, because the
  // socket cannot express half of what a reader needs — a queued session's transport is perfectly
  // healthy, and a session that ended is followed by a close that looks like a network failure.
  let session: SessionState | null = null;
  const sessionListeners = new Set<(state: SessionState) => void>();
  const setStatus = (next: WireStatus): void => {
    if (next === status) return;
    status = next;
    for (const cb of statusListeners) cb(status);
  };
  const client = connectWss<E, C>(url, {
    onEvent: (ev) => {
      seq += 1;
      state = opts.reduce(state, ev);
      const frame = { epoch, seq, ev };
      for (const cb of frameListeners) cb(frame);
    },
    onReady: () => {
      ready = true;
      setStatus("connected");
      const drained = queued;
      queued = [];
      for (const c of drained) client.send(c);
    },
    onClose: () => {
      ready = false;
      setStatus("lost");
    },
    onSession: (s) => {
      session = s;
      for (const cb of sessionListeners) cb(s);
      opts.onSession?.(s);
    },
  });
  return {
    onEvent(cb) {
      frameListeners.add(cb);
      return () => {
        frameListeners.delete(cb);
      };
    },
    send(command) {
      if (ready) client.send(command);
      else queued.push(command);
    },
    requestSnapshot(): Promise<Snapshot<S>> {
      return Promise.resolve({ state, epoch, seq });
    },
    onStatus(cb) {
      statusListeners.add(cb);
      cb(status);
      return () => {
        statusListeners.delete(cb);
      };
    },
    onSession(cb) {
      sessionListeners.add(cb);
      // A view that mounts mid-session is told where things stand, rather than waiting for the
      // next change that may never come: `live` is emitted once and a session can sit there for hours.
      if (session) cb(session);
      return () => {
        sessionListeners.delete(cb);
      };
    },
    ...(opts.recover ? { recover: opts.recover } : {}),
    ...(opts.contentOrigin !== undefined ? { contentOrigin: () => opts.contentOrigin! } : {}),
    close() {
      client.close();
    },
  };
}
