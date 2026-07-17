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

      // A second admit of the SAME id is refused SYNCHRONOUSLY inside admit —
      // never enqueued, so the pump can't re-materialise or overwrite the live
      // record. No wait needed: `queueDepth === 0` is the deterministic gate (a
      // broken guard would have `push`ed).
      const dupPhases: string[] = [];
      host.admit({ sessionId: "X", onState: (s) => dupPhases.push(s.phase) });

      expect(dupPhases).toEqual(["died"]); // the duplicate was refused
      expect(host.queueDepth).toBe(0); // never enqueued
      expect(host.occupancy).toBe(1); // still exactly one X
      expect(started.filter((id) => id === "X")).toHaveLength(1); // materialised once
      expect(disposed).toEqual([]); // the live X was NOT disposed/orphaned
    });
  });

  it("a throwing served.run dies that session but leaves the host + siblings alive", async () => {
    const { onState, phases } = stateCollector();
    const disposed: string[] = [];
    const served: ServedHarness = {
      async materialise(id: string): Promise<Materialised> {
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
        if (id === "boom") throw new Error("harness crashed");
        yield* suspend(); // a healthy sibling — stays live
      },
    };

    await run(function* () {
      const host = yield* createModelRuntimeHost({ served, maxNativeSessions: 4 });
      host.admit({ sessionId: "boom", onState: onState("boom") });
      host.admit({ sessionId: "ok", onState: onState("ok") });
      yield* waitFor(
        () =>
          (phases.get("boom")?.includes("died") ?? false) &&
          host.sessions.has("ok"),
        "boom died, ok live",
      );

      // The crashing harness reached the terminal `died` (never draining/reaped),
      // yet its context was still disposed + the slot freed — and the throw did
      // NOT propagate up the spawn to take down the pump.
      expect(phases.get("boom")).toEqual(["queued", "warming", "live", "died"]);
      expect(disposed).toEqual(["boom"]); // context freed despite the crash
      expect(host.sessions.has("boom")).toBe(false);

      // The host survived: the healthy sibling is still live, and the pump still
      // admits after a session crash.
      expect(host.sessions.has("ok")).toBe(true);
      host.admit({ sessionId: "later", onState: onState("later") });
      yield* waitFor(
        () => host.sessions.has("later"),
        "host still admits after a crash",
      );
      expect(host.occupancy).toBe(2);
    });
  });

  it("refuses a duplicate sessionId that races the warming window (materialise in flight)", async () => {
    const started: string[] = [];
    const disposed: string[] = [];
    // A gate that keeps the FIRST materialise pending until we release it —
    // parking the session in `warming` (shifted from `queue`, not yet in
    // `sessions`), the exact window the old queue/sessions dedup missed.
    let releaseMaterialise!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseMaterialise = resolve;
    });
    let firstBlocked = false;
    const served: ServedHarness = {
      async materialise(id: string): Promise<Materialised> {
        started.push(id);
        if (!firstBlocked) {
          firstBlocked = true;
          await gate; // hold the first admission in `warming`
        }
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

      host.admit({ sessionId: "R", onState: () => {} });
      // Wait until the pump has SHIFTED R out of the queue and is parked on
      // materialise: R is now in neither `queue` nor `sessions` — pure `warming`.
      yield* waitFor(
        () =>
          started.includes("R") &&
          host.queueDepth === 0 &&
          !host.sessions.has("R"),
        "R is warming (materialise in flight)",
      );

      // Duplicate admit DURING the warming window — the race. Must be refused
      // synchronously and never enqueued (a broken guard would queue it and, once
      // the pump re-ran, materialise a second context that overwrites the live R).
      const dupPhases: string[] = [];
      host.admit({ sessionId: "R", onState: (s) => dupPhases.push(s.phase) });
      expect(dupPhases).toEqual(["died"]);
      expect(host.queueDepth).toBe(0);

      // Let the first materialise finish → R goes live, materialised exactly once,
      // and the live R was never disposed/orphaned.
      releaseMaterialise();
      yield* waitFor(() => host.sessions.has("R"), "R live");
      expect(started.filter((id) => id === "R")).toHaveLength(1);
      expect(disposed).toEqual([]);
      expect(host.occupancy).toBe(1);
    });
  });

  it("release cancels a still-queued Session (never materialises, frees the id)", async () => {
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

      // Release C while it is still queued behind the cap. It must leave the
      // queue and never materialise a consumer-less harness.
      yield* call(() => host.release("C"));
      expect(host.queueDepth).toBe(0);
      expect(phases.get("C")).toEqual(["queued", "reaped"]); // never warmed
      expect(started).toEqual(["A", "B"]); // C never materialised
      expect(host.occupancy).toBe(2); // cap unaffected

      // Its id is freed — a fresh admit of "C" is accepted (would be refused if
      // release hadn't cleared `admitted`) and queues behind the cap.
      host.admit({ sessionId: "C", onState: onState("C") });
      yield* waitFor(() => host.queueDepth === 1, "fresh C re-queued");
    });

    // Host scope unwound → only the two live sessions had contexts to dispose;
    // the cancelled C never built one.
    expect(disposed.sort()).toEqual(["A", "B"]);
  });

  it("release during warming discards the just-built context (never spawns a harness)", async () => {
    const started: string[] = [];
    const disposed: string[] = [];
    const phasesW: string[] = [];
    // Hold the FIRST materialise pending so its session parks in `warming`.
    let releaseMaterialise!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseMaterialise = resolve;
    });
    let firstBlocked = false;
    const served: ServedHarness = {
      async materialise(id: string): Promise<Materialised> {
        started.push(id);
        if (!firstBlocked) {
          firstBlocked = true;
          await gate;
        }
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
      const host = yield* createModelRuntimeHost({ served, maxNativeSessions: 2 });
      host.admit({ sessionId: "W", onState: (s) => phasesW.push(s.phase) });
      yield* waitFor(
        () => started.includes("W") && !host.sessions.has("W"),
        "W is warming (materialise in flight)",
      );

      // Release W mid-warming, THEN let its materialise resolve. The pump must
      // discard the freshly-built context, not spawn a consumer-less harness.
      yield* call(() => host.release("W"));
      releaseMaterialise();
      yield* waitFor(
        () => disposed.includes("W"),
        "W's just-built context was disposed",
      );

      expect(host.sessions.has("W")).toBe(false); // never went live
      expect(host.occupancy).toBe(0); // slot freed
      expect(phasesW).toEqual(["queued", "warming", "reaped"]);
      expect(started.filter((id) => id === "W")).toHaveLength(1); // built once

      // The id freed and the pump is healthy — a fresh admit still goes live.
      host.admit({ sessionId: "W2", onState: () => {} });
      yield* waitFor(() => host.sessions.has("W2"), "host still admits after a warming cancel");
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
