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

// Node-only: Reranker factory (requires @lloyal-labs/lloyal.node)
export { createReranker } from './reranker';
export type { RerankerLoadOpts } from './reranker';

// Node-only: Resource loading (requires node:fs)
export { loadResources, chunkResources, resolveCorpusInput } from './resources';

// Node-only: model catalog + verified project-local resolution/fetch
// (requires node:fs / node:crypto / streaming fetch)
export { MODEL_CATALOG, catalogEntry, resolveModel, resolveRuntimeModels, fetchVerified } from './models';
export type { RuntimeModels } from './models';
export { useTraceWriter } from './trace-sink';
export { createProjectMediaStore, MEDIA_DIR } from './media-store';
// Node-only: the content plane — HTTP carries bytes, the WebSocket carries
// references. Mount beside a `WebSocketServer` on one `http.Server`.
export { createContentRoutes } from './content-routes';
export type { ContentRoutesOpts } from './content-routes';
export type {
  ModelRole,
  ModelCatalogEntry,
  ModelSpec,
  ModelProgress,
  ResolveModelOpts,
  FetchVerifiedOpts,
} from './models';

// Node-only: provision the auxiliary models an enabled ability set requires
// (aggregates each factory's manifest.services → resolveModel + createReranker + RerankerCtx)
// Node-only: config-file mechanics for the Runner substrate (hdk#109) —
// atomic 0600 writes, the writer's version guard, git check-ignore append,
// boundary path resolution. The per-template LAYERING stays in the scaffold.
export {
  resolvePath,
  resolveAppConfigPaths,
  readJsonOverlay,
  readJsonForWrite,
  writeJsonAtomic,
  maybeAppendGitignore,
} from './config-node';

export { provisionAbilityModels } from './provision';
export type { ProvisionAbilityModelsOpts } from './provision';
