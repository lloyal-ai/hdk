/**
 * The Runner substrate — the runner ↔ harness seam every template shared as a
 * per-scaffold copy until it was promoted here (hdk#109).
 *
 * `harness(ctx, events, commands)` reads `RunnerCtx` for the edge-shell
 * concerns it cannot own: the live resolved config, config persistence, a
 * model-reload request, the observability trace sink, and the persistent
 * wind-down / cancel signals. A placement's boot builds a `Runner` and sets
 * `RunnerCtx` before calling the harness.
 *
 * Generic over the harness's OWN config shape (`C`) and origin record (`O`) —
 * the shapes are the template's; the machinery is the platform's. Everything
 * platform-bound arrives by injection ({@link RunnerDevOpts},
 * {@link RunnerConfigOpts}), so this module imports no `node:*` and is safe
 * for any runtime, React Native included. The disk mechanics live in
 * `@lloyal-labs/rig/node`.
 *
 * NOT a host contract: `@lloyal-labs/host` speaks `ServedHarness`, never
 * `Runner`.
 *
 * @category Rig
 */
import { createContext, createSignal } from 'effection';
import type { Signal } from 'effection';
import { NullTraceWriter } from '@lloyal-labs/lloyal-agents';
import type { TraceWriter, BranchCheckpoint } from '@lloyal-labs/lloyal-agents';

/** One config rung, per field: which layer of
 *  `cli > env > harness.json > harness.yml > default` supplied the value.
 *  `file` = the local `harness.json`; `yml` = the committed manifest;
 *  `session` = patched in-memory by a served session (never written to disk). */
export type ConfigOriginValue = 'cli' | 'env' | 'file' | 'yml' | 'session' | 'default';

/** The minimal config shape the Runner machinery relies on. A template's
 *  `Config` extends this with its own fields (`defaults`, `surface`, a typed
 *  `model`, …) — the machinery never reads inside them. */
export interface BaseHarnessConfig {
  version: 1;
  sources: { outputDir?: string };
  abilities: Record<string, Record<string, unknown>>;
  model: object;
}

/** A config write: one-level-deep partial — a save carries only the keys it
 *  changes, so a local overlay never pins untouched values over the layers
 *  beneath it. */
export type ConfigPatch<C> = {
  [K in keyof C]?: C[K] extends object ? Partial<C[K]> : C[K];
};

export interface SaveResult {
  /** The file the save landed in, or null when nothing was persisted — a
   *  served session's in-memory patch. */
  path: string | null;
  /** true iff this save appended the config file to `.gitignore` during this
   *  call (at most once per repo; scaffolds ship it pre-listed). */
  gitignored: boolean;
  /** Reserved: fields deliberately skipped. Env fallbacks live in the owning
   *  ability's factory, not this layer. */
  skipped: string[];
}

/** The layered load result — config + per-field provenance + where the local
 *  file lives (whether or not it existed). */
export interface LoadedConfig<C, O> {
  config: C;
  origin: O;
  path: string;
  loadedFromFile: boolean;
}

/** Platform-owned observability, injected by the boot: the factories stay
 *  runtime-free, so a boot over ANY binding (Node, an RN shell over a native
 *  binding) supplies its own trace sink and dev signal. Omitted ⇒ Null sink,
 *  dev off. */
export interface RunnerDevOpts {
  traceWriter?: TraceWriter;
  dev?: boolean;
}

/**
 * Boot-owned config plumbing, injected like the dev sink. The boot that
 * layered the config passes the computed per-field `origin`, and — edge only —
 * a `persist` that writes the patch to disk and returns the re-layered result.
 * Absent `persist`, patches stay in-memory and their fields read `session`.
 */
export interface RunnerConfigOpts<
  C extends BaseHarnessConfig,
  O extends Record<string, ConfigOriginValue>,
> {
  origin: O;
  persist?: (patch: ConfigPatch<C>) => SaveResult & { config: C; origin: O };
  /** Patch-path → origin key (e.g. `{ "model.gpu": "gpu" }`) — DATA, the one
   *  place a template's origin surface differs. Drives the `session` marks on
   *  in-memory patches. */
  sessionOriginMap: Record<string, keyof O & string>;
  /** Boot-frozen on the edge reconcile: these keys describe the RUNNING
   *  residency, which a save cannot change (that is `reloadRuntime` + a
   *  relaunch). Defaults cover the shipped templates; keys absent from a
   *  given shape are ignored. */
  frozen?: { config?: readonly string[]; origin?: readonly string[] };
}

const DEFAULT_FROZEN_CONFIG: readonly string[] = ['model', 'surface'];
const DEFAULT_FROZEN_ORIGIN: readonly string[] = ['modelPath', 'reranker', 'nCtx', 'gpu'];

/** The runner ↔ harness contract. See the module docblock. */
export interface Runner<
  C extends BaseHarnessConfig,
  O extends Record<string, ConfigOriginValue>,
> {
  /** The live, resolved config. */
  config(): C;
  /** Provenance of each resolved config field. */
  origin(): O;
  /** Apply a patch: the live config evolves; with an injected `persist` the
   *  patch also lands on disk and provenance re-layers — value and origin
   *  move together in both directions. */
  saveConfig(patch: ConfigPatch<C>): SaveResult & { config: C; origin: O };
  /** Persist a model/reranker/gpu change. There is no in-process rebuild —
   *  the harness returns after calling this and the process ends; the next
   *  launch reads the file and applies it. In-memory (served) ⇒ no-op. */
  reloadRuntime(patch: ConfigPatch<C>): void;
  /** Persistent graceful-wind-down signal. */
  windDown: Signal<void, void>;
  /** Persistent per-agent cancel signal. */
  cancelAgent: Signal<{ agentId: number }, void>;
  /** Observability sink threaded into `initAgents`. */
  traceWriter: TraceWriter;
  /** True when the boot mounted dev observability (trace sink + pool
   *  epistemics). Read this, never `process.env` — harness code stays
   *  portable across bindings. */
  dev: boolean;
  /** Replay-mode spine checkpoint; null normally + served. */
  replayCheckpoint: BranchCheckpoint | null;
  /** A per-run findings cap (an edge flag); undefined = default. */
  findingsMaxChars: number | undefined;
  /** 'oneshot' = non-TTY run-once; 'interactive' = the command loop. */
  mode: 'interactive' | 'oneshot';
  /** A query to auto-submit (interactive, first iteration) or run (oneshot). */
  initialQuery: string | undefined;
  /** True only on the runner's first boot iteration — gates the auto-submit. */
  isFirstIteration: boolean;
}

/** The ambient seam the harness reads. Templates re-export a façade typed to
 *  their own `Config`/`ConfigOrigin`; one shared key across all placements. */
export const RunnerCtx = createContext<
  Runner<BaseHarnessConfig, Record<string, ConfigOriginValue>>
>('rig.runner');

/** Provenance selection that mirrors `??` exactly (`!= null` — a hand-edited
 *  null is a clear on every rung), so origin and selection cannot disagree by
 *  construction. */
export function rung<T>(
  c: T | null | undefined,
  e: T | null | undefined,
  l: T | null | undefined,
  y: T | null | undefined,
): ConfigOriginValue {
  return c != null ? 'cli' : e != null ? 'env' : l != null ? 'file' : y != null ? 'yml' : 'default';
}

/** One-level-deep merge of a patch into a config: object-valued families
 *  shallow-merge (abilities per-name whole-replace, defaults per-key), scalars
 *  replace; `sources.outputDir === ""` clears the key. Never mutates `base`. */
export function mergeConfig<C extends BaseHarnessConfig>(base: C, patch: ConfigPatch<C>): C {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    if (
      v !== null && typeof v === 'object' && !Array.isArray(v) &&
      b !== null && typeof b === 'object' && !Array.isArray(b)
    ) {
      out[k] = { ...b, ...v };
    } else {
      out[k] = v;
    }
  }
  out.version = 1;
  const sources = { ...(out.sources as { outputDir?: string }) };
  if (sources.outputDir === '') delete sources.outputDir;
  out.sources = sources;
  return out as C;
}

/** Mark every origin-tracked field a patch touches as `session` — the honest
 *  provenance for an in-memory change no file will remember. Driven by the
 *  template's {@link RunnerConfigOpts.sessionOriginMap}. */
export function markSession<
  C extends BaseHarnessConfig,
  O extends Record<string, ConfigOriginValue>,
>(origin: O, patch: ConfigPatch<C>, map: Record<string, keyof O & string>): O {
  const next: Record<string, ConfigOriginValue> = { ...origin };
  for (const [path, key] of Object.entries(map)) {
    const segs = path.split('.');
    let node: unknown = patch;
    for (let i = 0; i < segs.length - 1 && node; i++) {
      node = (node as Record<string, unknown>)[segs[i]];
    }
    const last = segs[segs.length - 1];
    if (node !== null && typeof node === 'object' && last in (node as object)) {
      next[key] = 'session';
    }
  }
  return next as O;
}

/** Restore `keys` in `next` to exactly their boot state — value OR absence. A
 *  frozen key that was absent at boot must stay absent, or a relayered file
 *  could bring it live mid-session despite the freeze. */
function restoreFrozen(
  next: Record<string, unknown>,
  boot: Record<string, unknown>,
  keys: readonly string[],
): void {
  for (const k of keys) {
    if (k in boot) next[k] = boot[k];
    else delete next[k];
  }
}

function makeRunner<
  C extends BaseHarnessConfig,
  O extends Record<string, ConfigOriginValue>,
>(cfg: C, opts: RunnerDevOpts & RunnerConfigOpts<C, O>, servedPath: null): Runner<C, O> {
  let sessionConfig = structuredClone(cfg);
  let sessionOrigin = { ...opts.origin };
  const windDown = createSignal<void, void>();
  const cancelAgent = createSignal<{ agentId: number }, void>();
  const frozenConfig = opts.frozen?.config ?? DEFAULT_FROZEN_CONFIG;
  const frozenOrigin = opts.frozen?.origin ?? DEFAULT_FROZEN_ORIGIN;
  void servedPath;
  return {
    config: () => sessionConfig,
    origin: () => sessionOrigin,
    saveConfig(patch) {
      if (opts.persist) {
        // Live-read fields reconcile from the re-layered files — value AND
        // origin together, so clearing a key restores the rung beneath it and
        // an env-outranked save shows the env value it actually runs with.
        // The frozen set (the model block) stays BOOT-FROZEN: it describes
        // the RUNNING residency, which a save cannot change.
        const saved = opts.persist(patch);
        const nextConfig = { ...saved.config } as Record<string, unknown>;
        restoreFrozen(nextConfig, sessionConfig as Record<string, unknown>, frozenConfig);
        const nextOrigin = { ...saved.origin } as Record<string, unknown>;
        restoreFrozen(nextOrigin, sessionOrigin as Record<string, unknown>, frozenOrigin);
        sessionConfig = nextConfig as C;
        sessionOrigin = nextOrigin as O;
        return { ...saved, config: sessionConfig, origin: sessionOrigin };
      }
      // In-memory only (served, or an edge boot without persistence): touched
      // fields read `session`; `path: null` says nothing reached disk.
      sessionConfig = mergeConfig(sessionConfig, patch);
      sessionOrigin = markSession(sessionOrigin, patch, opts.sessionOriginMap);
      return {
        path: null,
        gitignored: false,
        skipped: [],
        config: sessionConfig,
        origin: sessionOrigin,
      };
    },
    reloadRuntime(patch) {
      // Persist for the next launch; no in-process rebuild. No-op in-memory.
      opts.persist?.(patch);
    },
    windDown,
    cancelAgent,
    traceWriter: opts.traceWriter ?? new NullTraceWriter(),
    dev: opts.dev ?? false,
    replayCheckpoint: null,
    findingsMaxChars: undefined,
    mode: 'interactive',
    initialQuery: undefined,
    isFirstIteration: true,
  };
}

/**
 * Build the served `Runner` for ONE Session: its OWN config clone, fresh
 * signals, in-memory saves (`path: null` — a shared server-side file would
 * leak one tenant's settings into another's), `session` origin marks.
 */
export function makeServedRunner<
  C extends BaseHarnessConfig,
  O extends Record<string, ConfigOriginValue>,
>(cfg: C, opts: RunnerDevOpts & RunnerConfigOpts<C, O>): Runner<C, O> {
  // Served never persists — drop an accidentally-passed persist so a driver
  // can share one opts object between placements without leaking writes.
  const { persist: _persist, ...rest } = opts;
  return makeRunner(cfg, rest as RunnerDevOpts & RunnerConfigOpts<C, O>, null);
}

/**
 * Build the edge `Runner`: saves evolve the live clone AND persist through
 * the boot-injected `persist`; `reloadRuntime` persists too — the process
 * ends after it and the next launch applies the change.
 */
export function makeEdgeRunner<
  C extends BaseHarnessConfig,
  O extends Record<string, ConfigOriginValue>,
>(cfg: C, opts: RunnerDevOpts & RunnerConfigOpts<C, O>): Runner<C, O> {
  return makeRunner(cfg, opts, null);
}
