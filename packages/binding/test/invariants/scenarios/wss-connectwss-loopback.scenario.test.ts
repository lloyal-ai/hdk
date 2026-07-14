/**
 * Scenario: wss server ⇄ connectWss client — a full loopback.
 *
 * Every other transport test drives ONE side with hand-built frames. This wires
 * the REAL server transport to the REAL browser client — the server's `socket.send`
 * feeds the client's message listener, and the client's `ws.send` feeds the server's
 * message listener — so the server's serializer feeds the client's parser directly.
 *
 * The invariant: **serialize ∘ parse = identity across the routed envelope.** If the
 * `RoutedBindingFrame` shape ever drifts on one side, both sides' isolated tests stay
 * green while this fails — this is the only test that would catch it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createBus } from "../../../src/index";
import { wss } from "../../../src/node";
import { connectWss } from "../../../src/web";

const SID = "loop-1";

describe("scenario: wss server ⇄ connectWss client loopback", () => {
  afterEach(() => {
    // @ts-expect-error test-only global cleanup
    delete globalThis.WebSocket;
  });

  it("preserves events, bootstrap-before-ready, session frames, and the command up-channel", () => {
    let serverMsg: ((data: unknown) => void) | undefined;
    let clientMsg: ((ev: { data: unknown }) => void) | undefined;
    let clientClose: (() => void) | undefined;

    const serverSocket = {
      send: (data: string) => clientMsg?.({ data }), // server → client
      on: (event: "message" | "close", cb: (...a: never[]) => void) => {
        if (event === "message") serverMsg = cb as (d: unknown) => void;
      },
    };
    // @ts-expect-error install the browser global connectWss reads off globalThis
    globalThis.WebSocket = function () {
      return {
        send: (data: string) => serverMsg?.(data), // client → server
        close: () => clientClose?.(),
        addEventListener: (type: string, cb: (arg: never) => void) => {
          if (type === "message")
            clientMsg = cb as (ev: { data: unknown }) => void;
          else if (type === "close") clientClose = cb as () => void;
        },
      };
    };

    const events: unknown[] = [];
    const sessions: unknown[] = [];
    let readyCount = 0;
    // Construct the client FIRST so its message listener is live when the server
    // posts bootstrap on construction.
    const client = connectWss<{ type: string }, { do: string }>(
      "wss://loopback",
      {
        onEvent: (e) => events.push(e),
        onSession: (s) => sessions.push(s),
        onReady: () => readyCount++,
      },
    );

    const bus = createBus<{ type: string }>();
    const dispatched: unknown[] = [];
    const postSession = wss<{ type: string }, { do: string }>(
      serverSocket as never,
      {
        uiChannel: bus,
        dispatch: (c) => dispatched.push(c),
        bootstrap: [{ type: "config" }],
        sessionId: SID,
      },
    );

    // bootstrap arrives as an event, before the trailing ready.
    expect(events).toEqual([{ type: "config" }]);
    expect(readyCount).toBe(1);

    // a live harness event reaches the client, in order.
    bus.send({ type: "tick" });
    expect(events).toEqual([{ type: "config" }, { type: "tick" }]);

    // a gateway-authored session frame reaches onSession (the session plane).
    postSession({ phase: "live" });
    expect(sessions).toEqual([{ phase: "live" }]);

    // the command up-channel: client.send → server dispatch, echoing the server's sessionId.
    client.send({ do: "x" });
    expect(dispatched).toEqual([{ do: "x" }]);

    void clientClose; // wired for completeness; this scenario doesn't close.
  });
});
