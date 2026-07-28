/**
 * The harness config *schema* — the node-free type block.
 *
 * The `Runner` ({@link ./runner-ctx}) hands the harness its live config; this is
 * that config's shape. NO `node:fs`/`node:path` — a browser/renderer surface and
 * the served-runner factory both import these types, so the file must stay
 * runtime-free. `blank`'s runner (`makeEdgeRunner`) holds config in memory, so
 * there are no on-disk loaders to carve out — this is the whole config surface.
 *
 * It's deliberately lean: `apps` (per-app config the harness seeds the config
 * store from) + `model` (where the resident model lives). Grow it as your harness
 * grows — the reference `research` template's version adds run `defaults`
 * (reasoning mode / effort) the same way.
 */

export interface ConfigSources {
  /** Where a harness that writes run artifacts (reports, traces) puts them.
   *  `blank` writes none; the field is here so the `saveConfig` seam is complete
   *  for a harness that grows one. Default = process.cwd() at boot. */
  outputDir?: string;
}

/** Per-app stored config, keyed by `manifest.name` → the app's config object
 *  (whatever the app's `configSchema` declares; e.g. `{ corpusPath }`,
 *  `{ tavilyKey }`). The harness never reads inside these objects — it
 *  whole-replaces an app's entry and hands it to the registry, which validates
 *  against the app's `configSchema` on enable. The default wikipedia app needs
 *  none, so this stays empty. */
export type ConfigApps = Record<string, Record<string, unknown>>;

/** GPU backend variant — mirrors lloyal.node's `GpuVariant` union (config
 *  deliberately takes no lloyal.node dependency). 'default' is the portable
 *  CPU-capable build (works everywhere); 'cuda' / 'vulkan' request an accelerated
 *  build. An explicitly configured variant is a deliberate deploy choice — the
 *  served boot fails fast on an unavailable one (`LLOYAL_NO_FALLBACK`, see
 *  `applyServedGpuEnv`) rather than silently dropping to CPU. */
export type ConfigGpu = 'default' | 'cuda' | 'vulkan';

export interface ConfigModel {
  /** Filesystem path OR catalog id (e.g. `qwen3.5-4b`). Resolution is the
   *  caller's concern (`rig.resolveModel`) — config just stores whatever the
   *  boot resolved. */
  path?: string;
  /** The reranker model path/id, when an enabled app declares the `reranker`
   *  service. Empty for the default wikipedia app (needs none). */
  reranker?: string;
  /** LLM context window size. Null/undefined falls through to the default. */
  nCtx?: number;
  /** GPU backend variant. Null/undefined = the platform default backend. */
  gpu?: ConfigGpu;
  /** The model's display id + its measured on-disk size — the boot stats the
   *  resolved weight and stores these so the harness can render a *measured*
   *  boot header (see `BootFacts`), never a hardcoded string. */
  id?: string;
  sizeBytes?: number;
}

export interface Config {
  version: 1;
  sources: ConfigSources;
  /** Per-app stored config, keyed by `manifest.name`. The harness seeds
   *  `configStore` from this on boot (loop over entries) and whole-replaces
   *  an app's entry on `set_app_config`. */
  apps: ConfigApps;
  model: ConfigModel;
  /** Which surface this process mounted (`cli` · `desktop` · `pipe` · `web`) —
   *  a boot-time runtime fact the harness echoes into the boot header. */
  surface?: string;
}

/** Which layer supplied a given harness-level field — used for composer UI
 *  hints. `blank`'s in-memory runner reports everything as `default`. */
export interface ConfigOrigin {
  modelPath: 'cli' | 'file' | 'default';
  reranker: 'cli' | 'file' | 'default';
  nCtx: 'cli' | 'env' | 'file' | 'default';
  gpu: 'cli' | 'env' | 'file' | 'default';
  outputDir: 'cli' | 'file' | 'default';
}

export interface SaveResult {
  path: string;
  /** true iff this save appended a config file to `.gitignore` during this call.
   *  Always false for `blank`'s in-memory runner. */
  gitignored: boolean;
  /** Fields that were IN the patch but deliberately skipped (env won). */
  skipped: string[];
}
