/**
 * Served (B-host) placement — the harness-RUNNING half the driver INJECTS.
 * Isolated from the factories in `./served-runtime` because it imports the
 * `harness`: the web target's `serve.ts` hands it to the driver as `run`, and the
 * host calls it once per admitted Session as a structured child.
 *
 * Structurally identical to the reference `research` template + reasoning.run: a
 * Session provisions the enabled apps' Services into ITS OWN scope (a no-op for
 * the default wikipedia app, which needs none), builds the served `Runner`,
 * publishes it on `RunnerCtx`, and runs the UNCHANGED `harness(...)`. The provision
 * is per-session (not host-boot) so no tenant's context is shared — the same
 * isolation reasoning.run's per-session reranker gives. `cfg.model.reranker` is a
 * resolved `{path}` when a reranker-using app is enabled; absent, `provisionAppModels`
 * falls back to the platform catalog default (and is a no-op if no app needs one).
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
    // Sized for longer rerank inputs (rig defaults nCtx 4096). No-op for the
    // default wikipedia app; used the instant a reranker-using app is enabled.
    rerankerLoad: { nSeqMax: 10, nCtx: 16384 },
  });
  yield* RunnerCtx.set(makeServedRunner(cfg));
  yield* harness(ctx, events, commands);
}
