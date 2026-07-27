/**
 * Your harness's edge/served compute substrate — the harness-FREE half.
 *
 * The per-session `SessionContext` factory + the `Runner` factories (edge + served),
 * split from the `Runner` *interface* ({@link ./runner-ctx}) and from the
 * harness-RUNNING `runServedSession` ({@link ./served-session}) so these factories
 * import neither the `harness` nor anything it pulls — the web driver imports this
 * file (only `createServedContext`/`createServedChannels`) and stays harness-free.
 *
 * Structurally mirrors the reference `research` template + reasoning.run: a served
 * host materialises one `SessionContext` per admitted Session over one resident
 * model; lloyal.node's ModelRegistry weak-caches the model by path, so N Sessions
 * share the resident weights + each pays only its own KV. The reranker is NOT
 * built here — `provisionAppModels` (in the boot / `runServedSession`) loads it
 * and publishes it on `RerankerCtx`.
 */
import { createSignal } from "effection";
import type { Signal } from "effection";
import { createContext } from "@lloyal-labs/lloyal.node";
import type { SessionContext } from "@lloyal-labs/sdk";
import { NullTraceWriter } from "@lloyal-labs/lloyal-agents";
import { createBus, type EventBus } from "@lloyal-labs/binding";
import type { Runner } from "./runner-ctx.js";
import type { WorkflowEvent, Command } from "./protocol.js";
import type { Config, ConfigOrigin } from "./config-types.js";

/**
 * Steer the native backend for the resident model context via
 * `process.env.LLOYAL_GPU`. A configured backend is an EXPLICIT deploy request →
 * fail loud on an unavailable variant (`LLOYAL_NO_FALLBACK`, never overriding a
 * user-set one) instead of silently loading on CPU. With no gpu configured, any
 * inherited `LLOYAL_GPU` is CLEARED — config stays the source of truth.
 */
export function applyServedGpuEnv(cfg: Config): void {
  const gpu = cfg.model.gpu;
  if (gpu) {
    process.env.LLOYAL_GPU = gpu;
    if (process.env.LLOYAL_NO_FALLBACK === undefined) {
      process.env.LLOYAL_NO_FALLBACK = "1";
    }
  } else if (process.env.LLOYAL_GPU !== undefined) {
    delete process.env.LLOYAL_GPU;
  }
}

/** Build one Session's compute context over the resident model. Every Session's
 *  context is created over the SAME `cfg.model.path` → `lloyal.node`'s
 *  ModelRegistry weak-caches the weights, so N Sessions share one resident model,
 *  each paying only its own KV. */
export function createServedContext(cfg: Config): Promise<SessionContext> {
  const modelPath = cfg.model.path;
  if (!modelPath) {
    throw new Error(
      "createServedContext: cfg.model.path is required (the host's resident model)",
    );
  }
  applyServedGpuEnv(cfg);
  return createContext(
    {
      modelPath,
      nCtx: cfg.model.nCtx ?? 32768,
      nSeqMax: 32,
      typeK: "q4_0",
      typeV: "q4_0",
    },
    cfg.model.gpu ? { gpuVariant: cfg.model.gpu } : undefined,
  );
}

// A runner config isn't sourced from CLI/env/file — it's in-memory/deploy state.
// Every field reads as `default` for the composer's provenance hints.
const EPHEMERAL_ORIGIN: ConfigOrigin = {
  modelPath: "default",
  reranker: "default",
  nCtx: "default",
  gpu: "default",
  outputDir: "default",
};

/** Deep-merge a `saveConfig` patch into a config — a nested-object merge, purely
 *  in-memory. */
function mergeConfig(base: Config, patch: Partial<Config>): Config {
  const sources = { ...base.sources, ...(patch.sources ?? {}) };
  const model = { ...base.model, ...(patch.model ?? {}) };
  if (sources.outputDir === "") delete sources.outputDir;
  return {
    ...base,
    ...patch,
    version: 1,
    sources,
    apps: { ...base.apps, ...(patch.apps ?? {}) },
    model,
  };
}

/**
 * Build the served `Runner` for ONE Session. Everything here is per-session: its
 * OWN config clone (in-memory `saveConfig`), fresh wind-down / cancel signals, and
 * a null trace sink — so no runner state and no user data crosses between tenants.
 * The reranker is NOT a Runner concern: `runServedSession`'s `provisionAppModels`
 * publishes a per-session reranker on `RerankerCtx`. `reloadRuntime` is a no-op:
 * the model is a fixed host residency, so a config change that would rebuild it
 * just ends that Session.
 */
export function makeServedRunner(cfg: Config): Runner {
  let sessionConfig = structuredClone(cfg);
  const windDown = createSignal<void, void>();
  const cancelAgent = createSignal<{ agentId: number }, void>();
  const traceWriter = new NullTraceWriter();
  return {
    config: () => sessionConfig,
    origin: () => EPHEMERAL_ORIGIN,
    saveConfig(patch) {
      sessionConfig = mergeConfig(sessionConfig, patch);
      return {
        path: "<served>",
        gitignored: false,
        skipped: [],
        config: sessionConfig,
        origin: EPHEMERAL_ORIGIN,
      };
    },
    reloadRuntime(_patch: Partial<Config>) {
      // No-op — the model is a fixed host residency; it can't rebuild per Session.
    },
    windDown,
    cancelAgent,
    traceWriter,
    replayCheckpoint: null,
    findingsMaxChars: undefined,
    mode: "interactive",
    initialQuery: undefined,
    isFirstIteration: true,
  };
}

/**
 * Build the CLI edge `Runner` — this template's edge substrate. An in-memory,
 * ephemeral mirror of {@link makeServedRunner}: `saveConfig` mutates a private
 * clone (so config edits survive within a session but not across restarts — a
 * cold path, fine for an austere CLI), `reloadRuntime` is a no-op (the boot owns
 * the `SessionContext` lifetime), a NullTraceWriter, no replay, `interactive`
 * mode. The reranker is NOT here: the boot's `provisionAppModels` publishes it on
 * `RerankerCtx` before `harness` runs.
 */
export function makeEdgeRunner(cfg: Config): Runner {
  let sessionConfig = structuredClone(cfg);
  const windDown = createSignal<void, void>();
  const cancelAgent = createSignal<{ agentId: number }, void>();
  const traceWriter = new NullTraceWriter();
  return {
    config: () => sessionConfig,
    origin: () => EPHEMERAL_ORIGIN,
    saveConfig(patch) {
      sessionConfig = mergeConfig(sessionConfig, patch);
      return {
        path: "<in-memory>",
        gitignored: false,
        skipped: [],
        config: sessionConfig,
        origin: EPHEMERAL_ORIGIN,
      };
    },
    reloadRuntime(_patch: Partial<Config>) {
      // No-op — the CLI boot owns the SessionContext lifetime; a config change
      // that would rebuild it just ends the current run cleanly.
    },
    windDown,
    cancelAgent,
    traceWriter,
    replayCheckpoint: null,
    findingsMaxChars: undefined,
    mode: "interactive",
    initialQuery: undefined,
    isFirstIteration: true,
  };
}

/** The per-connection event bus + command signal. The socket binds to these at
 *  connect time (via binding's `wss()`); the harness sends/receives through them. */
export function createServedChannels(): {
  uiChannel: EventBus<WorkflowEvent>;
  commands: Signal<Command, void>;
} {
  return { uiChannel: createBus<WorkflowEvent>(), commands: createSignal<Command, void>() };
}
