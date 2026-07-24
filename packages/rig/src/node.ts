/**
 * Node.js-specific exports for @lloyal-labs/rig
 *
 * These require node:fs and/or @lloyal-labs/lloyal.node.
 * Import from `@lloyal-labs/rig/node` only in Node.js environments.
 *
 * Per-source bundles (web, corpus) live in their own packages
 * (`@lloyal-labs/web-app`, `@lloyal-labs/corpus-app`); rig now owns
 * only cross-app primitives (chunking, types, tools, reranker).
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
export { MODEL_CATALOG, catalogEntry, resolveModel, fetchVerified } from './models';
export type {
  ModelRole,
  ModelCatalogEntry,
  ModelSpec,
  ModelProgress,
  ResolveModelOpts,
  FetchVerifiedOpts,
} from './models';

// Node-only: provision the auxiliary models an enabled app set requires
// (aggregates each factory's manifest.services → resolveModel + createReranker + RerankerCtx)
export { provisionAppModels } from './provision';
export type { ProvisionAppModelsOpts } from './provision';
