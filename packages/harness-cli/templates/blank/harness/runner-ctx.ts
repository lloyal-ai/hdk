/**
 * The runner ↔ harness seam — your harness's edge substrate.
 *
 * `harness(ctx, events, commands)` reads `RunnerCtx` for the edge-shell concerns
 * it can't own: the live resolved config, config persistence, a model-reload
 * restart request, an observability trace sink, and the persistent wind-down /
 * cancel signals. A target's boot builds a `Runner` and sets `RunnerCtx` before
 * calling `harness`:
 *
 *   - cli   → {@link makeEdgeRunner}   (in-memory config, no-op reload, one boot)
 *   - web   → {@link makeServedRunner} (per-session, tenant-isolated)
 *
 * This is the SAME contract the reference `research` template and reasoning.run
 * use — so as your harness grows into config persistence, tracing, or graceful
 * wind-down, the seam is already here; you don't migrate to a different shape.
 *
 * The reranker is deliberately NOT a Runner concern: the boot's
 * `provisionAppModels` reads your enabled apps' `services` and publishes the
 * reranker on `RerankerCtx`. So an app that needs one just works, and the Runner
 * stays about the edge shell, not services.
 *
 * NOT a platform contract — `@lloyal-labs/host` speaks `ServedHarness`, never
 * `Runner`. This is your harness's private substrate.
 */
import { createContext } from "effection";
import type { Signal } from "effection";
import type { TraceWriter, BranchCheckpoint } from "@lloyal-labs/lloyal-agents";
import type { Config, ConfigOrigin, SaveResult } from "./config-types.js";

export interface Runner {
  /** The live, resolved config (CLI > env > file > default). */
  config(): Config;
  /** Provenance of each resolved config field (for `config:updated` echoes). */
  origin(): ConfigOrigin;
  /** Persist a config patch to the config layer + reload; returns the new
   *  resolved state. Edge-only in practice — never sent over the served wire. */
  saveConfig(
    patch: Partial<Config>,
  ): SaveResult & { config: Config; origin: ConfigOrigin };
  /** Persist a model/reranker/gpu change and request a runtime restart. No-op on
   *  a served/edge runner (the model is a fixed residency for the run). */
  reloadRuntime(patch: Partial<Config>): void;
  /** Persistent graceful-wind-down signal (one per process, survives restarts). */
  windDown: Signal<void, void>;
  /** Persistent per-agent cancel signal (one per process, survives restarts). */
  cancelAgent: Signal<{ agentId: number }, void>;
  /** Observability sink threaded into `initAgents`. */
  traceWriter: TraceWriter;
  /** Replay-mode spine checkpoint; null normally + served. `blank`'s pipeline
   *  doesn't implement trace-replay — the field is part of the uniform Runner
   *  contract so a harness that grows one reads it here. */
  replayCheckpoint: BranchCheckpoint | null;
  /** A per-run findings cap (an edge flag); undefined = default. */
  findingsMaxChars: number | undefined;
  /** 'oneshot' = non-TTY run-once; 'interactive' = the command loop (Ink or the
   *  fork-IPC / wss bridge). */
  mode: "interactive" | "oneshot";
  /** A query to auto-submit (interactive, first iteration) or run (oneshot). */
  initialQuery: string | undefined;
  /** True only on the runner's first boot iteration — gates the auto-submit. */
  isFirstIteration: boolean;
}

export const RunnerCtx = createContext<Runner>("blank.harness.runner");
