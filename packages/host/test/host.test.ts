import { describe, expect, it } from "vitest";
import { run, sleep, suspend, call, createSignal, type Operation } from "effection";
import { createBus } from "@lloyal-labs/binding";
import { createModelRuntimeHost } from "../src/host";
import type { Materialised, ServedHarness, SessionState } from "../src/types";

/**
 * A fake `ServedHarness` — no model, no GPU. `materialise` records the admission
 * and hands back a trivial substrate; `run` suspends forever (a live session)
 * until the host halts it. Lets us prove the host's admission/lifecycle plane in
 * isolation (the "prove-with-two-types" gate) without any native cost.
 */
function fakeHarness(): {
  served: ServedHarness;
  started: string[];
  disposed: string[];
  ran: string[];
} {
  const started: string[] = [];
  const disposed: string[] = [];
  const ran: string[] = [];
  const served: ServedHarness = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async materialise(id: string): Promise<Materialised> {
      started.push(id);
      return {
        context: { id },
        uiChannel: createBus<unknown>(),
        commands: createSignal<unknown, void>(),
        dispose() {
          disposed.push(id);
        },
      };
    },
    *run(_m: Materialised, id: string): Operation<void> {
      ran.push(id);
      yield* suspend(); // a live session — runs until the host halts it
    },
  };
  return { served, started, disposed, ran };
}

/** Collect each session's ordered `SessionState.phase` transitions. */
function stateCollector() {
  const phases = new Map<string, string[]>();
  const onState = (id: string) => (s: SessionState) => {
    const list = phases.get(id) ?? [];
    list.push(s.phase);
    phases.set(id, list);
  };
  return { phases, onState };
}

describe("ModelRuntimeHost", () => {
  it("admits up to the cap, queues the rest FIFO, and frees a slot on release", async () => {
    const { served, started, disposed } = fakeHarness();
    const { phases, onState } = stateCollector();

    await run(function* () {
      const host = yield* createModelRuntimeHost({ served, maxNativeSessions: 2 });

      host.admit({ sessionId: "A", onState: onState("A") });
      host.admit({ sessionId: "B", onState: onState("B") });
      host.admit({ sessionId: "C", onState: onState("C") });
      yield* sleep(20); // let the pump materialise A + B (materialise is async)

      // Cap holds: 2 live, 1 queued. `sessions.size` is the ledger.
      expect(host.occupancy).toBe(2);
      expect(host.queueDepth).toBe(1);
      expect([...host.sessions.keys()].sort()).toEqual(["A", "B"]);
      // Construction is serialised through the pump, in admission order.
      expect(started).toEqual(["A", "B"]);
      // C is parked at `queued` (never materialised).
      expect(phases.get("C")).toEqual(["queued"]);
      expect(phases.get("A")).toEqual(["queued", "warming", "live"]);

      // Release A → its context disposes, the slot frees, and the FIFO head (C)
      // is admitted into it. Await the halt (deterministic teardown), then a beat
      // for the re-pump to materialise C.
      yield* call(() => host.release("A"));
      yield* sleep(20);

      expect(host.occupancy).toBe(2);
      expect(host.sessions.has("A")).toBe(false);
      expect(host.sessions.has("C")).toBe(true);
      expect(disposed).toEqual(["A"]); // dispose ran before the slot was reused
      expect(phases.get("A")).toEqual([
        "queued",
        "warming",
        "live",
        "draining",
        "reaped",
      ]);
      expect(phases.get("C")).toEqual(["queued", "warming", "live"]);
      expect(started).toEqual(["A", "B", "C"]);
    });

    // Host scope unwound → every remaining session was halted + disposed.
    expect(disposed.sort()).toEqual(["A", "B", "C"]);
  });

  it("a failed materialise dies that session without stalling the pump", async () => {
    const { onState, phases } = stateCollector();
    const disposed: string[] = [];
    const served: ServedHarness = {
      async materialise(id: string): Promise<Materialised> {
        if (id === "bad") throw new Error("no context");
        return {
          context: { id },
          uiChannel: createBus<unknown>(),
          commands: createSignal<unknown, void>(),
          dispose() {
            disposed.push(id);
          },
        };
      },
      *run(): Operation<void> {
        yield* suspend();
      },
    };

    await run(function* () {
      const host = yield* createModelRuntimeHost({ served, maxNativeSessions: 4 });
      host.admit({ sessionId: "bad", onState: onState("bad") });
      host.admit({ sessionId: "good", onState: onState("good") });
      yield* sleep(20);

      // The bad one died; the pump kept going and admitted the good one.
      expect(phases.get("bad")).toEqual(["queued", "warming", "died"]);
      expect(host.sessions.has("bad")).toBe(false);
      expect(host.sessions.has("good")).toBe(true);
      expect(host.occupancy).toBe(1);
    });
  });
});
