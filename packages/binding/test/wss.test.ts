import { describe, it, expect, vi, afterEach } from "vitest";
import { createBus } from "../src/index";
import { wss } from "../src/node";
import { connectWss } from "../src/web";

// Every wss frame is routed: { sessionId, frame } (wire-protocol.md §4). The
// run-plane BindingFrame is transported unchanged inside `frame`; the session
// plane rides beside it as a SessionFrame.
const SID = "s1";

// ── wss (server transport) ─────────────────────────────────────
describe("wss — server transport", () => {
  function makeSocket() {
    const sent: unknown[] = [];
    let msgCb: ((data: unknown) => void) | undefined;
    let closeCb: (() => void) | undefined;
    const socket = {
      send: (data: string) => sent.push(JSON.parse(data)),
      on: (event: "message" | "close", cb: (...a: never[]) => void) => {
        if (event === "message") msgCb = cb as (data: unknown) => void;
        else closeCb = cb as () => void;
      },
    };
    return {
      socket,
      sent,
      // the relay delivers a raw string frame; wss JSON.parses it
      emit: (m: unknown) => msgCb?.(JSON.stringify(m)),
      close: () => closeCb?.(),
    };
  }

  it("routes bootstrap as {t:event} then a trailing {t:ready}, sessionId-wrapped", () => {
    const bus = createBus<{ type: string }>();
    const { socket, sent } = makeSocket();
    wss(socket, {
      uiChannel: bus,
      dispatch: () => {},
      bootstrap: [{ type: "config" }],
      sessionId: SID,
    });
    expect(sent).toEqual([
      { sessionId: SID, frame: { t: "event", payload: { type: "config" } } },
      { sessionId: SID, frame: { t: "ready" } },
    ]);
  });

  it("routes live events after ready", () => {
    const bus = createBus<{ type: string }>();
    const { socket, sent } = makeSocket();
    wss(socket, {
      uiChannel: bus,
      dispatch: () => {},
      bootstrap: [],
      sessionId: SID,
    });
    bus.send({ type: "tick" });
    expect(sent).toEqual([
      { sessionId: SID, frame: { t: "ready" } },
      { sessionId: SID, frame: { t: "event", payload: { type: "tick" } } },
    ]);
  });

  it("routes inbound {t:command} to dispatch; ignores non-command frames", () => {
    const bus = createBus<unknown>();
    const dispatch = vi.fn();
    const { socket, emit } = makeSocket();
    wss(socket, {
      uiChannel: bus,
      dispatch,
      bootstrap: [],
      sessionId: SID,
    });
    emit({ sessionId: SID, frame: { t: "command", payload: { do: "x" } } });
    emit({ sessionId: SID, frame: { t: "event", payload: { nope: 1 } } }); // not a command → ignored
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ do: "x" });
  });

  it("the returned postSession emits a gateway-authored session frame beside the run plane", () => {
    const bus = createBus<unknown>();
    const { socket, sent } = makeSocket();
    const postSession = wss(socket, {
      uiChannel: bus,
      dispatch: () => {},
      bootstrap: [],
      sessionId: SID,
    });
    postSession({ phase: "live" });
    expect(sent).toContainEqual({
      sessionId: SID,
      frame: { t: "session", payload: { phase: "live" } },
    });
  });

  it("detaches the bus when the socket closes", () => {
    const bus = createBus<{ type: string }>();
    const { socket, sent, close } = makeSocket();
    wss(socket, {
      uiChannel: bus,
      dispatch: () => {},
      bootstrap: [],
      sessionId: SID,
    });
    close();
    bus.send({ type: "after-close" });
    expect(sent).toEqual([{ sessionId: SID, frame: { t: "ready" } }]); // no event frame after close
  });
});

// ── connectWss (browser client) ────────────────────────────────────
describe("connectWss — browser client", () => {
  afterEach(() => {
    // @ts-expect-error test-only global cleanup
    delete globalThis.WebSocket;
  });

  function mockGlobalWs() {
    const ws = {
      sent: [] as unknown[],
      listeners: {} as Record<string, (arg: unknown) => void>,
      send(data: string) {
        this.sent.push(JSON.parse(data));
      },
      close: vi.fn(),
      addEventListener(type: string, cb: (arg: unknown) => void) {
        this.listeners[type] = cb;
      },
      emit(m: unknown) {
        this.listeners["message"]?.({ data: JSON.stringify(m) });
      },
      drop() {
        this.listeners["close"]?.(undefined);
      },
    };
    // A regular function (not an arrow) is newable; returning an object from a
    // constructor makes `new WebSocket(url)` yield our mock.
    // @ts-expect-error override the browser global for the test
    globalThis.WebSocket = function () {
      return ws;
    };
    return ws;
  }

  it("unwraps routed event / session / ready frames to handlers", () => {
    const ws = mockGlobalWs();
    const onEvent = vi.fn();
    const onSession = vi.fn();
    const onReady = vi.fn();
    connectWss<{ type: string }, unknown>("wss://x", {
      onEvent,
      onSession,
      onReady,
    });
    ws.emit({ sessionId: SID, frame: { t: "event", payload: { type: "tick" } } });
    ws.emit({
      sessionId: SID,
      frame: { t: "session", payload: { phase: "warming" } },
    });
    ws.emit({ sessionId: SID, frame: { t: "ready" } });
    expect(onEvent).toHaveBeenCalledWith({ type: "tick" });
    expect(onSession).toHaveBeenCalledWith({ phase: "warming" });
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("send() posts a routed {t:command} frame, echoing the server's sessionId", () => {
    const ws = mockGlobalWs();
    const client = connectWss<unknown, { do: string }>("wss://x", {
      onEvent: () => {},
    });
    ws.emit({ sessionId: SID, frame: { t: "ready" } }); // client learns the sessionId
    client.send({ do: "x" });
    expect(ws.sent).toEqual([
      { sessionId: SID, frame: { t: "command", payload: { do: "x" } } },
    ]);
  });

  it("reports onClose when the socket drops", () => {
    const ws = mockGlobalWs();
    const onClose = vi.fn();
    connectWss<unknown, unknown>("wss://x", { onEvent: () => {}, onClose });
    ws.drop();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
