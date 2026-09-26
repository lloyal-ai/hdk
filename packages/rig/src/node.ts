/**
 * Node.js-specific exports for @lloyal-labs/rig
 *
 * These require node:fs and/or @lloyal-labs/lloyal.node.
 * Import from `@lloyal-labs/rig/node` only in Node.js environments.
 *
 * Per-source bundles (web, corpus) live in their own packages
 * (`@lloyal-labs/web-ability`, `@lloyal-labs/corpus-ability`); rig now owns
 * only cross-ability primitives (chunking, types, tools, reranker) and the
 * substrate a harness mounts under all of them — config, traces, and the
 * content plane (`createProjectMediaStore` + `createContentRoutes`).
 *
 * The content plane is here, rather than in `binding` beside the run and
 * session planes, because it resolves through an `AttachmentStore` and so
 * needs `@lloyal-labs/lloyal-agents` — and `binding` is deliberately
 * dependency-free, with `wss()` taking a structural socket rather than
 * importing one. Its `node:http` types are `import type` only, erased at
 * compile time, so they add nothing to any bundle.
 *
 * @packageDocumentation
 * @category Rig
 */

// Re-export everything from the platform-agnostic barrel
export * from './index';

// Node-only: the providers — one per service, each binding its artifact (requires @lloyal-labs/lloyal.node)
export { providers } from './providers';
export type { ProviderRow, ModelBlock } from './providers';
export { createReranker } from './providers/reranker';
export type { RerankerLoadOpts } from './providers/reranker';
export { createEmbedder } from './providers/embedding';
export type { EmbedderLoadOpts } from './providers/embedding';

// Node-only: Resource loading (requires node:fs)
export { loadResources, chunkResources, resolveCorpusInput } from './resources';

// Node-only: model catalog + verified project-local resolution/fetch
// (requires node:fs / node:crypto / streaming fetch)
export { MODEL_CATALOG, catalogEntry, modelSlot, isModelPresent, resolveModel, fetchVerified, DownloadStopped } from './models';
// Node-only: the install — what a run acquires before it can work, step by step, from the model family alone.
export { install, planInstall } from './install';
export type { InstallOpts, Installed, PlannedStep } from './install';
export { useTraceWriter } from './trace-sink';
export { createProjectMediaStore, MEDIA_DIR } from './media-store';
// Node-only: the content plane — HTTP carries bytes, the WebSocket carries
// references. `resolveContent` is the route table itself, so a target that is
// not an HTTP server — a desktop `protocol.handle` — answers the same routes
// without opening a socket; `createContentRoutes` is that table mounted beside
// a `WebSocketServer` on one `http.Server`.
export { createContentRoutes, resolveContent, isContentPath } from './content-routes';
export type { ContentRoutesOpts, ContentRequest, ContentReply } from './content-routes';
export type {
  ModelRole,
  ModelCatalogEntry,
  ModelSpec,
  ModelProgress,
  ResolveModelOpts,
  FetchVerifiedOpts,
} from './models';

// Node-only: the framework's walk over the providers — what a configuration names, each artifact
// resolved into its slot, each bound through its provider into reach.
export { configuredServices, resolveServices, bindServices, trunkOptions } from './provision';
export type { ProvisionOpts, ServiceArtifacts } from './provision';
// Node-only: config-file mechanics for the Runner substrate (hdk#109) —
// atomic 0600 writes, the writer's version guard, git check-ignore append,
// boundary path resolution. The per-template LAYERING stays in the scaffold.
export {
  resolvePath,
  isPathShaped,
  resolveAppConfigPaths,
  readJsonOverlay,
  readJsonForWrite,
  writeJsonAtomic,
  maybeAppendGitignore,
} from './config-node';

// Node-only: a library's folder mechanics — a name minted and its folder reserved
// exclusively, a client path confined by its real location, a listing held to the
// same rule, removal. What a folder holds is the app's.
export { reserveFolder, confined, listFolders, removeFolder } from './folders';

// Node-only: the layering a `defineConfig` table describes — harness.yml read loud,
// the rungs layered with provenance, harness.json written back, the Runner's plumbing.
export { loadYml, loadConfig, saveLocalConfig, runnerConfig } from './config-layering';
export type { ConfigSource } from './config-layering';

// Node-only: the one rig default — the Runner's knobs as a command group.
export { settings } from './settings';
export type { SettingsDeps } from './settings';


// Node-only: the host-resources sampler a dev boot runs beside the trace writer.
export { startHostResources } from './host-resources';

// Node-only: the engine's half of a desktop shell's ingress, over the utilityProcess channel.
export { serveIngest } from './ingest-responder';
export type { IngestRequest, IngestReply } from './ingest-responder';

// Node-only: the resident context, the served host's per-connection seam, and the two boots a target entry is one call to.
export { createResidentContext, residentContextOptions, applyGpuEnv, DEFAULT_N_SEQ_MAX, DEFAULT_N_CTX } from './resident-context';
export type { ResidentModel } from './resident-context';
export { createServedChannels, createServedHostDriver } from './served-host';
export type { ServedChannels, ServedHostDriver, ServedHostDriverOpts, OwnedConnection } from './served-host';
export { bootEdge, bootServed, DEFAULT_MAX_SESSIONS } from './boot';
export type { HarnessApp, BootEdgeOpts, BootServedOpts } from './boot';
