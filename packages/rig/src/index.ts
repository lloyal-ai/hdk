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

// Tools (pure TS + Effection + linkedom — platform-agnostic)
export {
  createTools, reportTool, ReportTool,
  WebSearchTool, TavilyProvider, createKeylessSearchProvider, FetchPageTool,
  DelegateTool,
  PlanTool, taskToContent,
} from './tools';
export type {
  DelegateToolOpts,
  KeylessSearchOptions,
  PlanToolOpts,
  PlanResult, PlanIntent, ResearchTask,
  SearchProvider, SearchResult,
  Reranker, ScoredChunk, ScoredResult,
} from './tools';

// Cross-app Source type re-export (platform-agnostic)
export type { SourceContext } from './sources/types';

// Chunking helpers (platform-agnostic — linkedom is pure JS).
// Shared by the web app's source and the rig-resident fetch_page tool.
export { chunkFetchedPages, chunkHtml } from './sources/chunking';
export type { FetchedPage } from './sources/chunking';

// Resource types (pure TS — RN-safe)
export type { Resource, Chunk } from './resources/types';

// HDK 3.0 App Protocol surfaces (RFC §5)
export {
  BOUNDARY_MARKER,
  FRAMEWORK_INTRO,
  TOOL_SELECTION_RULE,
  CATALOG_ENTRY,
  VALIDATED_MODELS_3_0,
  APP_PROTOCOL_VERSION,
  SUPPORTED_APP_PROTOCOL_VERSIONS,
  CHANNEL_CATALOG_URL,
  CHANNEL_TRUST_ROOTS,
} from './protocol';
export { defineApp } from './define-app';
export { cancellableFetch, FetchTimeoutError } from './cancellable-fetch';
export { createInMemoryConfigStore } from './config-store';
export { createGrantStore } from './grant-store';
export { createAppRegistry } from './registry';
export type { CreateAppRegistryOpts } from './registry';
export {
  verifyBundle,
  resolveAppEntry,
  BundleVerificationError,
  AppNotFoundError,
} from './bundle';
export type { AppBundleManifest, CatalogEntry, CatalogVersion, SignedCatalog } from './bundle';
export { renderSpine, renderAgentPreamble } from './spine-render';
export type { RenderSpineOptions } from './spine-render';
