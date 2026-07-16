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

/** Poll until `predicate` holds (or throw) — a condition wait, so assertions are
 *  not hostage to a fixed sleep on a loaded CI box. */
function* waitFor(
  predicate: () => boolean,
  label = "condition",
  timeoutMs = 2000,
): Operation<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: "${label}" not met within ${timeoutMs}ms`);
    }
    yield* sleep(2);
  }
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
      yield* waitFor(
        () => host.occupancy === 2 && host.queueDepth === 1,
        "A + B live, C queued",
      );

      // Cap holds: 2 live, 1 queued. `sessions.size` is the ledger.
      expect([...host.sessions.keys()].sort()).toEqual(["A", "B"]);
      // Construction is serialised through the pump, in admission order.
      expect(started).toEqual(["A", "B"]);
      // C is parked at `queued` (never materialised).
      expect(phases.get("C")).toEqual(["queued"]);
      expect(phases.get("A")).toEqual(["queued", "warming", "live"]);

      // Release A → its context disposes, the slot frees, and the FIFO head (C)
      // is admitted into it. Await the halt (deterministic teardown), then wait
      // for the re-pump to materialise C.
      yield* call(() => host.release("A"));
      yield* waitFor(
        () => host.sessions.has("C") && !host.sessions.has("A"),
        "C admitted into A's freed slot",
      );

      expect(host.occupancy).toBe(2);
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
      yield* waitFor(
        () =>
          host.sessions.has("good") &&
          (phases.get("bad")?.includes("died") ?? false),
        "bad died, good live",
      );

      // The bad one died; the pump kept going and admitted the good one.
      expect(phases.get("bad")).toEqual(["queued", "warming", "died"]);
      expect(host.sessions.has("bad")).toBe(false);
      expect(host.occupancy).toBe(1);
    });
  });

  it("refuses a duplicate sessionId without orphaning the live one", async () => {
    const { served, started, disposed } = fakeHarness();
    const { onState } = stateCollector();

    await run(function* () {
      const host = yield* createModelRuntimeHost({ served, maxNativeSessions: 4 });
      host.admit({ sessionId: "X", onState: onState("X") });
      yield* waitFor(() => host.sessions.has("X"), "X live");

      // A second admit of the SAME id must be refused — never a second
      // materialise, never an overwrite of the live record.
      const dupPhases: string[] = [];
      host.admit({ sessionId: "X", onState: (s) => dupPhases.push(s.phase) });
      yield* sleep(20); // give the pump every chance to (wrongly) re-materialise

      expect(dupPhases).toEqual(["died"]); // the duplicate was refused
      expect(host.occupancy).toBe(1); // still exactly one X
      expect(started.filter((id) => id === "X")).toHaveLength(1); // materialised once
      expect(disposed).toEqual([]); // the live X was NOT disposed/orphaned
    });
  });

  it("survives an onState callback that throws (one bad observer can't sink the host)", async () => {
    const { served } = fakeHarness();

    await run(function* () {
      const host = yield* createModelRuntimeHost({ served, maxNativeSessions: 2 });
      // A throwing observer fires inside the pump fiber — it must not abort it.
      host.admit({
        sessionId: "T",
        onState: () => {
          throw new Error("boom");
        },
      });
      yield* waitFor(
        () => host.sessions.has("T"),
        "T admitted despite a throwing onState",
      );
      expect(host.occupancy).toBe(1);

      // The pump is still alive — a subsequent admission still works.
      host.admit({ sessionId: "U", onState: () => {} });
      yield* waitFor(
        () => host.sessions.has("U"),
        "U admitted after a throwing observer",
      );
      expect(host.occupancy).toBe(2);
    });
  });
});
