/**
 * The runner ↔ harness seam — this harness's OWN edge substrate.
 *
 * `harness(ctx, events, commands)` reads `RunnerCtx` for the edge-shell concerns
 * it cannot own: the persistent wind-down / cancel signals, the live resolved
 * config, config persistence, and the model-reload restart request. A target's
 * boot sets `RunnerCtx` before calling `harness`.
 *
 *   - cli   → {@link makeEdgeRunner}   (in-memory config, no-op reload, one boot)
 *   - web   → {@link makeServedRunner} (per-session, tenant-isolated)
 *
 * (The reranker is NOT a Runner concern: the boot's `provisionAppModels` reads
 * the enabled apps' `services` and publishes the reranker on `RerankerCtx` in the
 * harness's scope — the same context `registry.enable` reads. So a harness that
 * outgrows this template gets the SAME platform contract: a reranker-less Runner +
 * `provisionAppModels` for services.)
 *
 * NOT a platform contract — `@lloyal-labs/host` speaks `ServedHarness`, never
 * `Runner`. This is the reference harness's private substrate, reproduced so the
 * template builds the pipeline itself.
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
  /** Persist a model/reranker/gpu change and request a runtime restart: the runner
   *  tears down the current `SessionContext` + rebuilds, then re-instantiates
   *  `harness` on the new context. The harness returns after calling this. No-op on
   *  a served/edge runner (the model is a fixed residency for the run). */
  reloadRuntime(patch: Partial<Config>): void;
  /** Persistent graceful-wind-down signal (one per process, survives restarts). */
  windDown: Signal<void, void>;
  /** Persistent per-agent cancel signal (one per process, survives restarts). */
  cancelAgent: Signal<{ agentId: number }, void>;
  /** Observability sink threaded into `initAgents`. */
  traceWriter: TraceWriter;
  /** Replay-mode spine checkpoint (edge `--replay-trace`); null normally + served. */
  replayCheckpoint: BranchCheckpoint | null;
  /** `--findings-budget` cap (edge flag); undefined = default. */
  findingsMaxChars: number | undefined;
  /** 'oneshot' = non-TTY `--query`/JSONL (run once, no plan-review gate);
   *  'interactive' = Ink or the fork-IPC / wss bridge (the command loop). */
  mode: "interactive" | "oneshot";
  /** The `--query` to auto-submit (interactive, first iteration) or run (oneshot). */
  initialQuery: string | undefined;
  /** True only on the runner's first boot iteration — gates the `--query` auto-submit. */
  isFirstIteration: boolean;
}

export const RunnerCtx = createContext<Runner>("research.harness.runner");
