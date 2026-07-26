/**
 * Served (B-host) placement — the harness-RUNNING half. Isolated from the
 * factories in `./served-runtime` because it imports the `harness` (and thus its
 * `.eta` prompts): anything importing this file must be esbuilt with
 * `--loader:.eta=text`, never run as raw `tsx`. The web target's `serve.ts`
 * injects this as the host's `run`.
 *
 * SNAPSHOT: reasoning.run @ main (src/served-session.ts).
 */
import type { Operation, Signal } from "effection";
import type { SessionContext } from "@lloyal-labs/sdk";
import type { EventBus } from "@lloyal-labs/binding";
import { provisionAppModels } from "@lloyal-labs/rig/node";
import { harness, apps } from "./harness.js";
import { RunnerCtx } from "./runner-ctx.js";
import { applyServedGpuEnv, makeServedRunner } from "./served-runtime.js";
import type { WorkflowEvent, Command } from "./protocol.js";
import type { Config } from "./config-types.js";

/**
 * Run ONE served Session end to end: provision its per-session reranker + app
 * services (its OWN reranker KV context over the shared resident weights, so
 * tenant documents never cross the reranker context), build the served `Runner`,
 * publish it on `RunnerCtx`, and run the UNCHANGED `harness(...)` over this
 * Session. `provisionAppModels` reads the corpus/web apps' static
 * `services: ['reranker']`, loads the reranker, and publishes it on `RerankerCtx`
 * in THIS scope — the scope `harness()` runs in, so `registry.enable` injects it.
 * The host `spawn`s this as the per-session child; its scope owns BOTH the
 * reranker resource (disposes on teardown) and the `RunnerCtx` binding, so N
 * sessions share no runner state and no native reranker context.
 *
 * `cfg.model.reranker` is `serve.ts`'s resolved (digest-verified) reranker path →
 * a `{path}` spec rig uses as-is (no re-fetch). `applyServedGpuEnv(cfg)` runs
 * FIRST so the reranker load below (rig has no loadOptions passthrough) rides the
 * same `LLOYAL_GPU` as the resident context.
 *
 * The last three params ARE the `harness(ctx, events, commands)` signature — the
 * driver forwards the `{context, uiChannel, commands}` it materialised for the host.
 */
export function* runServedSession(
  cfg: Config,
  ctx: SessionContext,
  events: EventBus<WorkflowEvent>,
  commands: Signal<Command, void>,
): Operation<void> {
  applyServedGpuEnv(cfg);
  yield* provisionAppModels({
    apps,
    projectRoot: process.cwd(),
    reranker: cfg.model.reranker ? { path: cfg.model.reranker } : undefined,
    // 10 leases (2 for trunk + queryBranch, 8 effective scoring leaves); nCtx
    // 16384 (rig defaults 4096) sizes the reranker for longer rerank inputs.
    rerankerLoad: { nSeqMax: 10, nCtx: 16384 },
  });
  yield* RunnerCtx.set(makeServedRunner(cfg));
  yield* harness(ctx, events, commands);
}
