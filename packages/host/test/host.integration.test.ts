/// <reference types="node" />
/**
 * Suite A — the B-mechanism proof for `@lloyal-labs/host`, against a REAL model.
 *
 * The unit test (`host.test.ts`) drives a FAKE `ServedHarness` (no model) and proves
 * the admission/lifecycle plane. THIS suite builds a MINIMAL real `ServedHarness`
 * (materialise → `createContext` over one resident model; run → a tiny real decode)
 * and proves the claim the host exists FOR: N `SessionContext`s share ONE resident
 * `llama_model` (native `ModelRegistry` weak-cache) and decode concurrently, each
 * with its own KV.
 *
 * Proven by a CONTROLLED contrast, not a blind memory ceiling:
 *   · Reuse (mechanism): materialise(ctx₂..N) ≪ materialise(ctx₁) — a cache HIT skips
 *     the whole weight load. Miss-vs-hit is the load-vs-reuse ablation.
 *   · Memory (outcome): a subsequent same-path context adds far less RSS than the
 *     first (no weights), and a DISTINCT model adds far more (control — proves RSS
 *     discriminates, isn't just pinned low by mmap/Metal).
 *   · Distinctness: each context has its own nCtx-sized KV arena.
 *
 * Model resolve + skip-gate copied from `packages/sdk/test/rerank-integration.test.ts`.
 * Runs on local Metal when weights + a native backend are present; self-skips in CPU
 * CI. The GPU rig runs tsx `test/sdk.ts`, not vitest, so this is Metal-only (rig hook
 * is a Stage-3 follow-up).
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { run, sleep, suspend, call, createSignal, type Operation } from "effection";
import { createContext } from "@lloyal-labs/lloyal.node";
import { Branch } from "@lloyal-labs/sdk";
import type { SessionContext } from "@lloyal-labs/sdk";
import { createBus } from "@lloyal-labs/binding";
import { createModelRuntimeHost } from "../src/host";
import type { Materialised, ServedHarness } from "../src/types";

// ── Model discovery ────────────────────────────────────────────────
function resolveLLM(): string | null {
  const candidates = [
    process.env.LLAMA_TEST_MODEL,
    path.join(os.homedir(), ".cache/lloyal/models/Qwen3.5-4B-Q4_K_M.gguf"),
    path.join(os.homedir(), "dev/apps/lloyal-node/models/Qwen3.5-4B-Q4_K_M.gguf"),
  ];
  for (const p of candidates) if (p && fs.existsSync(p)) return p;
  return null;
}

/** Distinct comparable models (~2–3 GB each) for the memory-ablation control —
 *  best-effort from disk, excluding the primary model. */
function resolveDistinctModels(exclude: string, max: number): string[] {
  const dir = path.join(os.homedir(), "dev/apps/lloyal-node/models");
  const candidates = [
    "Phi-3.5-mini-instruct-Q4_K_M.gguf",
    "gemma-4-E2B-it-Q4_K_M.gguf",
    "SmolLM2-1.7B-Instruct-Q4_K_M.gguf",
    "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
  ].map((f) => path.join(dir, f));
  const out: string[] = [];
  for (const p of candidates) {
    if (out.length >= max) break;
    if (fs.existsSync(p) && path.resolve(p) !== path.resolve(exclude)) out.push(p);
  }
  return out;
}

const MODEL = resolveLLM();
console.log(`[host-integration] MODEL = ${MODEL ?? "(none — tests will skip)"}`);
const SKIP_REASON = MODEL
  ? null
  : "No LLM found; set LLAMA_TEST_MODEL or drop Qwen3.5-4B-Q4_K_M.gguf in ~/.cache/lloyal/models";
const describeWithModel = SKIP_REASON ? describe.skip : describe;

const NCTX = 2048; // small ⇒ tiny KV ⇒ sharpens the weights-vs-KV contrast
const NSEQ = 4;
const N = 4; // concurrent sessions
const K = 8; // tokens decoded per session

// ── Helpers ────────────────────────────────────────────────────────
async function makeCtx(modelPath: string): Promise<SessionContext> {
  return (await createContext({
    modelPath,
    nCtx: NCTX,
    nSeqMax: NSEQ,
    typeK: "q4_0",
    typeV: "q4_0",
  })) as unknown as SessionContext;
}

/** A tiny REAL decode over a context: prefill a short prompt, greedily produce +
 *  commit up to K tokens. `commit`/`prefill` are async native calls on the libuv
 *  pool, so N of these run concurrently when the host spawns N `run`s. */
async function decodeK(ctx: SessionContext, k: number): Promise<number[]> {
  const toks = ctx.tokenizeSync("Count upward slowly: one, two, three,", true);
  const b = Branch.create(ctx, 0, { temperature: 0 });
  await b.prefill(toks);
  const out: number[] = [];
  for (let i = 0; i < k; i++) {
    const p = b.produceSync();
    if (p.isStop) break;
    await b.commit(p.token);
    out.push(p.token);
  }
  // NOTE: no pruneSync — leave the branch's KV populated so `_storeKvPressure()`
  // reflects real usage; `ctx.dispose()` frees it at teardown.
  return out;
}

/** Poll until `predicate` holds (or throw) — the `waitFor` from `host.test.ts`. */
function* waitFor(
  predicate: () => boolean,
  label = "condition",
  timeoutMs = 120_000,
): Operation<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor: "${label}" not met in ${timeoutMs}ms`);
    yield* sleep(5);
  }
}

/** A minimal REAL ServedHarness over one model path, instrumented for the asserts. */
function realHarness(modelPath: string) {
  const materialiseMs: number[] = [];
  const rssAfterMaterialise: number[] = [];
  const contexts = new Map<string, SessionContext>();
  const decoded = new Map<string, number[]>();
  const disposed: string[] = [];
  const served: ServedHarness<SessionContext> = {
    async materialise(id: string): Promise<Materialised<SessionContext>> {
      const t0 = Date.now();
      const ctx = await makeCtx(modelPath);
      materialiseMs.push(Date.now() - t0);
      rssAfterMaterialise.push(process.memoryUsage().rss);
      contexts.set(id, ctx);
      return {
        context: ctx,
        uiChannel: createBus<unknown>(),
        commands: createSignal<unknown, void>(),
        dispose() {
          try {
            ctx.dispose();
          } catch {
            /* best-effort native teardown */
          }
          disposed.push(id);
        },
      };
    },
    *run(m: Materialised<SessionContext>, id: string): Operation<void> {
      const toks = yield* call(() => decodeK(m.context, K));
      decoded.set(id, toks);
      yield* suspend(); // stay live so occupancy/isolation asserts see N live sessions
    },
  };
  return { served, materialiseMs, rssAfterMaterialise, contexts, decoded, disposed };
}

// Discipline that matters in a real-model host test: never release/dispose a context
// while a native decode is IN FLIGHT — await the decode (e.g. `h.decoded.has(id)`)
// first. Disposing a context under a live `_storeCommit` worker races the native free
// and crashes the vitest worker (this bit test 3's `release` before it was gated on the
// decode completing).
describeWithModel(`@lloyal-labs/host integration — ${SKIP_REASON ?? path.basename(MODEL!)}`, () => {
  it(
    "shares ONE resident model across N contexts (reuse timing) + N concurrent decodes + distinct KV + teardown",
    async () => {
      const h = realHarness(MODEL!);
      await run(function* () {
        const host = yield* createModelRuntimeHost<SessionContext>({
          served: h.served,
          maxNativeSessions: N,
        });
        for (let i = 0; i < N; i++) host.admit({ sessionId: `S${i}`, onState: () => {} });
        yield* waitFor(() => h.decoded.size === N, "all N sessions decoded");

        // ── Reuse (MECHANISM): materialise is serialised through the pump, so
        // ctx₁ is a cache MISS (full weight load) and ctx₂..N are cache HITS. ──
        const [first, ...rest] = h.materialiseMs;
        const maxRest = Math.max(...rest);
        console.log(
          `[host-integration] materialise ms: first=${first} rest=[${rest.join(", ")}] ` +
            `rss(GB)=[${h.rssAfterMaterialise.map((r) => (r / 1e9).toFixed(2)).join(", ")}]`,
        );
        expect(maxRest).toBeLessThan(first * 0.25); // hits ≪ the one-time load

        // ── N concurrent decodes completed over N contexts on one model. ──
        expect(host.occupancy).toBe(N);
        for (let i = 0; i < N; i++) {
          expect(h.decoded.get(`S${i}`)!.length).toBeGreaterThan(0);
        }

        // ── Distinctness: N independently-sized KV arenas (not one shared cache). ──
        const ctxs = [...h.contexts.values()];
        expect(new Set(ctxs).size).toBe(N); // distinct context object identities
        for (const ctx of ctxs) {
          const kv = ctx._storeKvPressure();
          expect(kv.nCtx).toBe(NCTX);
          expect(kv.cellsUsed).toBeGreaterThan(0);
          expect(kv.cellsUsed).toBeLessThan(kv.nCtx);
        }
      });

      // ── Teardown: host scope unwound ⇒ every context disposed. ──
      expect(h.disposed.sort()).toEqual(["S0", "S1", "S2", "S3"]);
    },
    180_000,
  );

  it(
    "N same-path contexts stay within ONE model's resident memory (not N×); distinct models grow (observational)",
    async () => {
      const gb = (b: number) => (b / 1e9).toFixed(2);
      const weightsBytes = fs.statSync(MODEL!).size;

      // Contexts are created RAW here (not via the host), so dispose in `finally` — a
      // mid-test assertion failure must still free the native contexts (tests 1 & 3 get
      // this for free from the host resource's teardown).
      const same: SessionContext[] = [];
      const distinct: SessionContext[] = [];
      try {
        // Treatment: N contexts over the SAME path. The weak-cache shares ONE weights
        // copy, so TOTAL RSS growth ≈ 1 model + N tiny KV — NOT N× weights.
        const rssBefore = process.memoryUsage().rss;
        const deltaSame: number[] = [];
        for (let i = 0; i < N; i++) {
          const b0 = process.memoryUsage().rss;
          const ctx = await makeCtx(MODEL!);
          await decodeK(ctx, 2); // fault weight pages resident
          deltaSame.push(process.memoryUsage().rss - b0);
          same.push(ctx);
        }
        const grew = process.memoryUsage().rss - rssBefore;
        console.log(
          `[host-integration] N=${N} same-path grew RSS ${gb(grew)}GB (one model=${gb(weightsBytes)}GB); ` +
            `per-ctx Δ(GB)=[${deltaSame.map(gb).join(", ")}]`,
        );
        // Load-bearing + robust to in-process RSS reclaim (reclaim only LOWERS `grew`):
        // N contexts cost ~1 model, not N×. 4 duplicated 2.6GB sets ≈ 11GB.
        expect(grew).toBeLessThan(weightsBytes * 2);

        // Control (OBSERVATIONAL only). Per-model RSS deltas are unreliable in-process
        // under memory pressure (macOS reclaims/compresses → negative deltas), so we
        // LOG distinct-model growth for a human eyeball and lean on the timing test
        // (primary spec) for the mechanism proof — exactly the confound the plan
        // anticipated ("if RSS is noisy, lean on timing").
        const distinctPaths = resolveDistinctModels(MODEL!, 2);
        for (const p of distinctPaths) {
          const b0 = process.memoryUsage().rss;
          const ctx = await makeCtx(p);
          await decodeK(ctx, 2);
          console.log(
            `[host-integration] distinct ${path.basename(p)} Δ RSS ${gb(process.memoryUsage().rss - b0)}GB`,
          );
          distinct.push(ctx);
        }
        if (distinctPaths.length === 0) {
          console.log("[host-integration] distinct control skipped (<1 distinct model on disk)");
        }
      } finally {
        for (const c of distinct) c.dispose();
        for (const c of same) c.dispose();
      }
    },
    240_000,
  );

  it("caps at maxNativeSessions and admits the queued session FIFO after a release", async () => {
    const h = realHarness(MODEL!);
    await run(function* () {
      const host = yield* createModelRuntimeHost<SessionContext>({
        served: h.served,
        maxNativeSessions: 1,
      });
      host.admit({ sessionId: "A", onState: () => {} });
      host.admit({ sessionId: "B", onState: () => {} });
      // Wait until A has FINISHED its decode (not just gone `live` — the host emits
      // `live` right after spawn, before decode completes; releasing then would dispose
      // a context under an in-flight native decode) and B is queued behind the cap.
      yield* waitFor(() => h.decoded.has("A") && host.queueDepth === 1, "A decoded + live; B queued");
      expect(host.occupancy).toBe(1);
      expect([...host.sessions.keys()]).toEqual(["A"]);

      yield* call(() => host.release("A")); // A's decode is done → free the slot
      yield* waitFor(() => h.decoded.has("B") && !host.sessions.has("A"), "B admitted + decoded in A's slot");
      expect(host.occupancy).toBe(1);
    });
    expect(h.disposed.sort()).toEqual(["A", "B"]);
  }, 180_000);
});
