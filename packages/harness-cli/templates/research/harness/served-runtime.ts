/**
 * The harness's edge/served compute substrate — the harness-FREE half.
 *
 * The per-session `SessionContext` factory + the `Runner` factories (edge + served),
 * split from the `Runner` *interface* ({@link ./runner-ctx}) and from the
 * harness-RUNNING `runServedSession` ({@link ./served-session}) so these factories
 * import neither the `harness` nor its `.eta` prompts — a web driver imports this
 * file (only `createServedContext`/`createServedChannels`) without pulling esbuild.
 *
 * Copied from reasoning.run's `served-runtime.ts`. A served host materialises one
 * `SessionContext` per admitted Session over one resident model; lloyal.node's
 * ModelRegistry weak-caches the model by path, so the Nth session shares the
 * resident weights + only allocates a fresh KV context. The reranker is NOT built
 * here — `provisionAppModels` (in `runServedSession` / the cli boot) loads it and
 * publishes it on `RerankerCtx`, so no factory here touches it.
 */
import { createSignal } from "effection";
import type { Signal } from "effection";
import { createContext as createNativeContext } from "@lloyal-labs/lloyal.node";
import type { SessionContext } from "@lloyal-labs/sdk";
import { NullTraceWriter } from "@lloyal-labs/lloyal-agents";
import { createBus, type EventBus } from "@lloyal-labs/binding";
import type { Runner } from "./runner-ctx.js";
import type { WorkflowEvent, Command } from "./protocol.js";
import type { Config, ConfigOrigin } from "./config-types.js";

/**
 * Steer the native backend for BOTH the resident model context AND the reranker
 * via `process.env.LLOYAL_GPU` (rig's `createReranker` exposes no loadOptions
 * passthrough). A configured backend is an EXPLICIT deploy request → fail loud on
 * an unavailable variant (`LLOYAL_NO_FALLBACK`, never overriding a user-set one)
 * instead of silently loading on CPU. With no gpu configured, any inherited
 * `LLOYAL_GPU` is CLEARED — config stays the sole source of truth.
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

/**
 * Build one `SessionContext` over the resident model. Called once per admitted
 * Session (in the host's `materialise`); lloyal.node's ModelRegistry weak-caches
 * the model by path, so the Nth call shares the resident weights and only
 * allocates a fresh KV context.
 */
export function createServedContext(cfg: Config): Promise<SessionContext> {
  const modelPath = cfg.model.path;
  if (!modelPath) {
    throw new Error(
      "createServedContext: cfg.model.path is required (the host's resident model)",
    );
  }
  applyServedGpuEnv(cfg);
  return createNativeContext(
    {
      modelPath,
      nCtx: cfg.model.nCtx ?? 32768,
      nSeqMax: 24,
      typeK: "q4_0",
      typeV: "q4_0",
    },
    cfg.model.gpu ? { gpuVariant: cfg.model.gpu } : undefined,
  );
}

// A runner config isn't sourced from CLI/env/file — it's in-memory/deploy state.
// Every field reads as `default` for the composer's provenance hints.
const EPHEMERAL_ORIGIN: ConfigOrigin = {
  reasoningMode: "default",
  modelPath: "default",
  reranker: "default",
  nCtx: "default",
  gpu: "default",
  outputDir: "default",
};

/** Deep-merge a `saveConfig` patch into a config — the same nested-object merge
 *  the file loader used, but purely in-memory. */
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
    defaults: { ...base.defaults, ...(patch.defaults ?? {}) },
    model,
  };
}

/**
 * Build the served `Runner` for ONE Session. Everything here is per-session: its
 * OWN config clone (in-memory `saveConfig`), fresh wind-down / cancel signals, and
 * a null trace sink — so no runner state and no user data crosses between tenants.
 * The reranker is NOT a Runner concern: `runServedSession`'s `provisionAppModels`
 * publishes a per-session reranker on `RerankerCtx` in the harness's scope.
 * `reloadRuntime` is a no-op: the model is a fixed host residency, so a /model or
 * /gpu change can't rebuild it — the harness's unconditional `return` after calling
 * it simply ends that Session.
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
 * clone (so /output-dir, /effort survive within a session but not across
 * restarts — a cold path, fine for an austere CLI), `reloadRuntime` is a no-op
 * (the boot owns the `SessionContext` lifetime; a config change that would
 * rebuild it just ends the run), a NullTraceWriter, no replay, `interactive`
 * mode. The reranker is NOT here: the boot's `provisionAppModels` publishes it on
 * `RerankerCtx` before `harness` runs, exactly as reasoning.run's edge boot does.
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
      // No-op — the CLI boot owns the SessionContext lifetime; a /model or /gpu
      // change can't rebuild it mid-run. The harness `return`s right after
      // calling this, ending the current run cleanly.
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

/** Build a fresh per-session event bus + command signal. A web driver pairs this
 *  with {@link createServedContext} to satisfy the host's `materialise`. */
export function createServedChannels(): {
  uiChannel: EventBus<WorkflowEvent>;
  commands: Signal<Command, void>;
} {
  return {
    uiChannel: createBus<WorkflowEvent>(),
    commands: createSignal<Command, void>(),
  };
}
