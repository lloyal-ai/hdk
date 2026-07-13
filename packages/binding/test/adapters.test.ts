import { describe, it, expect, vi, afterEach } from "vitest";
import { createBus } from "../src/index";
import { ndjson, ipc } from "../src/node";

describe("ndjson — one-way JSON Lines binding", () => {
  it("drains bootstrap then streams live events as raw NDJSON, in order", () => {
    const bus = createBus<{ type: string }>();
    const lines: string[] = [];
    ndjson<{ type: string }>({ out: (l) => lines.push(l) })(
      bus,
      () => {},
      [{ type: "a" }, { type: "b" }],
    );
    expect(lines).toEqual(['{"type":"a"}', '{"type":"b"}']); // bootstrap, in order
    bus.send({ type: "c" });
    expect(lines).toEqual(['{"type":"a"}', '{"type":"b"}', '{"type":"c"}']); // live after
  });

  it("emits raw events — no BindingFrame envelope, no ready, no inbound dispatch", () => {
    const bus = createBus<{ type: string }>();
    const lines: string[] = [];
    let dispatched = 0;
    ndjson<{ type: string }>({ out: (l) => lines.push(l) })(
      bus,
      () => {
        dispatched++;
      },
      [{ type: "boot" }],
    );
    expect(lines).toEqual(['{"type":"boot"}']);
    // no `{"t":...}` frame envelope and no `ready` — ndjson is raw + one-way
    expect(lines.some((l) => l.includes('"t":') || l.includes('"payload"'))).toBe(
      false,
    );
    expect(dispatched).toBe(0); // ndjson has no command channel
  });
});

describe("ipc — parentPort-else-fork bridge binding", () => {
  afterEach(() => {
    delete (process as unknown as { parentPort?: unknown }).parentPort;
    vi.useRealTimers();
  });

  it("posts framed events + a trailing ready, and dispatches inbound commands", () => {
    vi.useFakeTimers(); // contain ipc's keep-alive interval
    const posted: unknown[] = [];
    let onMessage: ((e: { data: unknown }) => void) | undefined;
    (process as unknown as { parentPort: unknown }).parentPort = {
      postMessage: (m: unknown) => posted.push(m),
      on: (_e: "message", cb: (e: { data: unknown }) => void) => {
        onMessage = cb;
      },
      start: () => {},
    };
    const bus = createBus<{ type: string }>();
    const commands: unknown[] = [];
    ipc<{ type: string }, unknown>()(bus, (c) => commands.push(c), [
      { type: "boot" },
    ]);
    // bootstrap framed as an event, then a trailing ready
    expect(posted).toEqual([
      { t: "event", payload: { type: "boot" } },
      { t: "ready" },
    ]);
    // live events keep framing
    bus.send({ type: "live" });
    expect(posted).toContainEqual({ t: "event", payload: { type: "live" } });
    // inbound `command` frames dispatch; other frames are ignored (up-channel only for commands)
    onMessage?.({ data: { t: "command", payload: { cmd: "ping" } } });
    onMessage?.({ data: { t: "event", payload: {} } });
    expect(commands).toEqual([{ cmd: "ping" }]);
  });

  it("throws a clear error when there is no IPC channel", () => {
    const orig = process.send;
    delete (process as unknown as { parentPort?: unknown }).parentPort;
    (process as unknown as { send?: unknown }).send = undefined; // simulate no fork IPC
    try {
      expect(() => ipc()(createBus(), () => {}, [])).toThrow(/no IPC channel/);
    } finally {
      (process as unknown as { send?: unknown }).send = orig;
    }
  });
});
