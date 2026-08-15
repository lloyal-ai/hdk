/**
 * Rig — data sources and tools for the lloyal agent pipeline
 *
 * The default export is platform-agnostic. linkedom + @mozilla/readability
 * are pure JS and work in both Node.js and React Native (Hermes).
 *
 * Node-specific exports (createReranker, loadResources, chunkResources)
 * require node:fs and are available via `@lloyal-labs/rig/node`.
 *
 * @packageDocumentation
 * @category Rig
 */

// Framework tools (consumed by harnesses) + search providers (consumed by
// abilities' Source implementations). Ability-scoped Tool classes live in their
// owning ability (`@lloyal-labs/{web,corpus,wikipedia}-ability`).
export {
  reportTool, ReportTool,
  TavilyProvider, createKeylessSearchProvider,
  DelegateTool,
  PlanTool, taskToContent,
} from './tools';
export type {
  DelegateToolOpts,
  KeylessSearchOptions,
  PlanToolOpts,
  ReportToolOpts,
  PlanResult, PlanIntent, ResearchTask,
  SearchProvider, SearchResult,
  Reranker, ScoredChunk, ScoredResult,
} from './tools';

// Cross-ability Source type re-export (platform-agnostic)
export type { SourceContext } from './sources/types';

// Chunking helpers (platform-agnostic — linkedom is pure JS).
// Shared by the web ability's source and the rig-resident fetch_page tool.
export { chunkFetchedPages, chunkHtml } from './sources/chunking';
export type { FetchedPage } from './sources/chunking';

// Resource types (pure TS — RN-safe)
export type { Resource, Chunk } from './resources/types';

// HDK 3.0 Ability Protocol surfaces
export {
  BOUNDARY_MARKER,
  FRAMEWORK_INTRO,
  TOOL_SELECTION_RULE,
  CATALOG_ENTRY,
  VALIDATED_MODELS_3_0,
  ABILITY_PROTOCOL_VERSION,
  SUPPORTED_ABILITY_PROTOCOL_VERSIONS,
  TASK_ROUTING_KEY,
  CHANNEL_CATALOG_URL,
  CHANNEL_TRUST_ROOTS,
} from './protocol';
export { defineAbility } from './define-ability';
export type { AbilitySetup } from './define-ability';
export { cancellableFetch, FetchTimeoutError } from './cancellable-fetch';
export { createInMemoryConfigStore } from './config-store';
export { createGrantStore } from './grant-store';
export { createAbilityRegistry } from './registry';
export type { CreateAbilityRegistryOpts } from './registry';
export {
  verifyBundle,
  resolveAbilityEntry,
  BundleVerificationError,
  AbilityNotFoundError,
} from './bundle';
export type {
  AbilityBundleManifest,
  CatalogEntry,
  CatalogEntryMetadata,
  CatalogVersion,
  SignedCatalog,
} from './bundle';
export { renderSpine, renderAgentPreamble } from './spine-render';
export type { RenderSpineOptions } from './spine-render';
