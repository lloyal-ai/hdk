/**
 * Scenario: ipc keep-alive teardown on parent disconnect (orphan prevention).
 *
 * A `child_process.fork()` child holds the libuv loop open with a keep-alive
 * interval while its suspended command loop waits. If the parent dies, the child
 * must stop that interval and exit — otherwise it lingers as an orphan holding a
 * dead IPC channel. This is the specific regression for the round-7 fix
 * (`process.on("disconnect")` → stop keep-alive + mark closed).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createBus } from "../../../src/index";
import { ipc } from "../../../src/node";

describe("scenario: ipc parent-disconnect stops the keep-alive (no orphan)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (process as unknown as { parentPort?: unknown }).parentPort;
  });

  it("clears the keep-alive interval and halts posting when the parent disconnects", () => {
    vi.useFakeTimers();
    // Capture process listeners rather than emitting a real 'disconnect' — a
    // synthetic disconnect on the vitest worker could disturb its own IPC.
    const handlers: Record<string, (...a: unknown[]) => void> = {};
    vi.spyOn(process, "on").mockImplementation(((
      ev: string,
      cb: (...a: unknown[]) => void,
    ) => {
      handlers[ev] = cb;
      return process;
    }) as never);

    const posted: unknown[] = [];
    (process as unknown as { parentPort: unknown }).parentPort = {
      postMessage: (m: unknown) => posted.push(m),
      on: () => {},
      start: () => {},
    };

    const bus = createBus<{ type: string }>();
    ipc<{ type: string }, unknown>()(bus, () => {}, []);
    expect(vi.getTimerCount()).toBe(1); // keep-alive holds the libuv loop open
    posted.length = 0; // drop the trailing ready

    handlers["disconnect"]?.(); // the parent closed the IPC channel

    expect(vi.getTimerCount()).toBe(0); // keep-alive cleared → the child can exit
    bus.send({ type: "orphaned" });
    expect(posted).toHaveLength(0); // closed on disconnect → nothing posted to the dead channel
  });
});
