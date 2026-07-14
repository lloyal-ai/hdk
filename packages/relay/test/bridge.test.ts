import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { connectWss } from "@lloyal-labs/binding/web";

// Mock node:child_process.fork to hand back a controllable fake child, so the
// bridge's lifecycle + routing + cleanup can be exercised without a real bin.
const h = vi.hoisted(() => {
  // Hand-rolled fork-child fake: a hoisted factory runs BEFORE module imports,
  // so it can't reference the imported EventEmitter.
  const makeChild = () => {
    const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
    const child = {
      killed: false,
      connected: true,
      send: vi.fn(),
      kill: vi.fn(() => {
        child.killed = true;
      }),
      on(ev: string, cb: (...a: unknown[]) => void) {
        (listeners[ev] ??= []).push(cb);
      },
      emit(ev: string, ...args: unknown[]) {
        (listeners[ev] ?? []).forEach((cb) => cb(...args));
      },
    };
    return child;
  };
  const state: { child?: ReturnType<typeof makeChild> } = {};
  const fork = vi.fn(() => {
    state.child = makeChild();
    return state.child;
  });
  return { state, fork };
});
vi.mock("node:child_process", () => ({ fork: h.fork }));

import { bridgeConnection, type RelaySocket } from "../src/index";

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  closed = false;
  send = vi.fn((d: string) => {
    if (this.closed) throw new Error("socket closed");
    this.sent.push(d);
  });
  close = vi.fn(() => {
    this.closed = true;
    this.emit("close");
  });
}

const asSocket = (s: FakeSocket): RelaySocket => s as unknown as RelaySocket;

beforeEach(() => h.fork.mockClear());

describe("bridgeConnection", () => {
  it("authors warming→live→died and routes frames both ways", () => {
    const socket = new FakeSocket();
    const states: { phase: string; code?: number }[] = [];
    bridgeConnection(asSocket(socket), {
      harness: { bin: "x" },
      onState: (s) => states.push(s),
    });
    const child = h.state.child!;

    // `warming` posted on fork.
    expect(states[0]).toEqual({ phase: "warming" });
    expect(h.fork).toHaveBeenCalledOnce();

    // child `ready` → `live`.
    child.emit("message", { t: "ready" });
    expect(states.at(-1)).toEqual({ phase: "live" });

    // a child event frame is wrapped + routed to the socket.
    socket.sent.length = 0;
    child.emit("message", { t: "event", payload: { x: 1 } });
    expect(JSON.parse(socket.sent[0]!).frame).toEqual({
      t: "event",
      payload: { x: 1 },
    });

    // a socket command frame is unwrapped + forwarded (bare) to the child.
    socket.emit(
      "message",
      JSON.stringify({ sessionId: "z", frame: { t: "command", payload: "go" } }),
    );
    expect(child.send).toHaveBeenCalledWith({ t: "command", payload: "go" });

    // child exit → `died` + socket closed.
    child.emit("exit", 0, null);
    expect(states.at(-1)).toMatchObject({ phase: "died", code: 0 });
    expect(socket.close).toHaveBeenCalled();
  });

  it("stops routing after the socket closes (no send-after-close crash)", () => {
    const socket = new FakeSocket();
    bridgeConnection(asSocket(socket), { harness: { bin: "x" } });
    const child = h.state.child!;
    socket.emit("close"); // client disconnects → dispose → closed
    socket.send.mockClear();
    // a late child message must not throw and must not reach the closed socket.
    expect(() => child.emit("message", { t: "event", payload: 1 })).not.toThrow();
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("guards child.send when the child is disconnected (no crash)", () => {
    const socket = new FakeSocket();
    bridgeConnection(asSocket(socket), { harness: { bin: "x" } });
    const child = h.state.child!;
    child.connected = false;
    child.send.mockImplementation(() => {
      throw new Error("ERR_IPC_CHANNEL_CLOSED");
    });
    expect(() =>
      socket.emit(
        "message",
        JSON.stringify({
          sessionId: "z",
          frame: { t: "command", payload: "x" },
        }),
      ),
    ).not.toThrow();
    expect(child.send).not.toHaveBeenCalled();
  });

  it("dispose kills the child", () => {
    const socket = new FakeSocket();
    const dispose = bridgeConnection(asSocket(socket), { harness: { bin: "x" } });
    const child = h.state.child!;
    dispose();
    expect(child.kill).toHaveBeenCalled();
  });

  it("does not fork an orphan if the warming post fails (dead socket)", () => {
    const socket = new FakeSocket();
    socket.send.mockImplementation(() => {
      throw new Error("dead socket");
    });
    bridgeConnection(asSocket(socket), { harness: { bin: "x" } });
    expect(h.fork).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalled();
  });

  it("a send failure tears down: kills the child and closes the socket", () => {
    const socket = new FakeSocket();
    bridgeConnection(asSocket(socket), { harness: { bin: "x" } });
    const child = h.state.child!;
    socket.send.mockImplementation(() => {
      throw new Error("dead socket");
    });
    child.emit("message", { t: "event", payload: 1 }); // route → send throws → dispose
    expect(child.kill).toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalled();
  });

  it("reports died + tears down if fork throws (bad bin)", () => {
    const socket = new FakeSocket();
    const states: { phase: string }[] = [];
    h.fork.mockImplementationOnce(() => {
      throw new Error("ENOENT: bad bin");
    });
    const dispose = bridgeConnection(asSocket(socket), {
      harness: { bin: "nope" },
      onState: (s) => states.push(s),
    });
    expect(states.map((s) => s.phase)).toEqual(["warming", "died"]);
    expect(socket.close).toHaveBeenCalled();
    expect(typeof dispose).toBe("function");
  });

  it("reports died + tears down on an async child 'error' (spawn failure)", () => {
    // fork() returns a child then fails to spawn asynchronously (ENOENT) — Node
    // emits `error`, which crashes the relay if unlistened. The bridge must
    // report `died` and tear down instead. (The sync-throw path is covered above;
    // this is the async-emit path fork()'s try/catch cannot see.)
    const socket = new FakeSocket();
    const states: { phase: string }[] = [];
    bridgeConnection(asSocket(socket), {
      harness: { bin: "x" },
      onState: (s) => states.push(s),
    });
    const child = h.state.child!;
    child.emit("error", new Error("spawn ENOENT"));
    expect(states.at(-1)).toEqual({ phase: "died" });
    expect(child.kill).toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalled();
  });

  it("reports died only once when error is followed by exit", () => {
    const socket = new FakeSocket();
    const states: { phase: string }[] = [];
    bridgeConnection(asSocket(socket), {
      harness: { bin: "x" },
      onState: (s) => states.push(s),
    });
    const child = h.state.child!;
    child.emit("error", new Error("spawn ENOENT"));
    child.emit("exit", 1, null); // Node may still fire exit after a spawn error
    expect(states.filter((s) => s.phase === "died")).toHaveLength(1);
  });

  it("stops forwarding commands to the child after dispose", () => {
    const socket = new FakeSocket();
    const dispose = bridgeConnection(asSocket(socket), { harness: { bin: "x" } });
    const child = h.state.child!;
    dispose();
    child.send.mockClear();
    socket.emit(
      "message",
      JSON.stringify({ sessionId: "z", frame: { t: "command", payload: "x" } }),
    );
    expect(child.send).not.toHaveBeenCalled();
  });
});

// Cross-package loopback: the relay's routed envelope must be exactly what the
// binding's real browser client (`connectWss`) parses. The relay and the client
// are tested in isolation elsewhere with hand-built frames — only wiring one's
// output into the other's input catches an envelope drift between them.
describe("bridge ⇄ connectWss client loopback", () => {
  afterEach(() => {
    // @ts-expect-error test-only global cleanup
    delete globalThis.WebSocket;
  });

  it("the relay's routed envelope matches the client's unwrap, both directions", () => {
    let clientMsg: ((ev: { data: unknown }) => void) | undefined;
    let clientClose: (() => void) | undefined;
    let socketMsg: ((data: unknown) => void) | undefined;

    const relaySocket = {
      send: (data: string) => clientMsg?.({ data }), // relay → client
      on: (event: "message" | "close", cb: (...a: never[]) => void) => {
        if (event === "message") socketMsg = cb as (d: unknown) => void;
      },
      close: () => {},
    };
    // @ts-expect-error install the browser global connectWss reads
    globalThis.WebSocket = function () {
      return {
        send: (data: string) => socketMsg?.(data), // client → relay
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
    let ready = 0;
    // client first, so its message listener is live when the relay posts `warming`.
    const client = connectWss<{ hello: number }, { go: number }>("wss://x", {
      onEvent: (e) => events.push(e),
      onSession: (s) => sessions.push(s),
      onReady: () => ready++,
    });

    bridgeConnection(relaySocket as unknown as RelaySocket, {
      harness: { bin: "x" },
    });
    const child = h.state.child!;

    // the relay authored `warming` on fork → reaches the client's session plane.
    expect(sessions).toContainEqual({ phase: "warming" });

    // child `ready` → `live` (session plane) + the client's run-plane onReady.
    child.emit("message", { t: "ready" });
    expect(ready).toBe(1);
    expect(sessions).toContainEqual({ phase: "live" });

    // a bare child event frame → wrapped by the relay → unwrapped to onEvent.
    child.emit("message", { t: "event", payload: { hello: 1 } });
    expect(events).toEqual([{ hello: 1 }]);

    // command down: client.send → relay unwrap → bare frame to child.send.
    client.send({ go: 1 });
    expect(child.send).toHaveBeenCalledWith({ t: "command", payload: { go: 1 } });

    void clientClose;
  });
});
