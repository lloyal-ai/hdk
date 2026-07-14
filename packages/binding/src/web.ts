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
