import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

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
