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
  PlanTool, taskToContent, singleTaskPlan, taskKey, taskIndexOf,
  defineOutput, citedReport, weaveSourcesIntoResult, weaveOrdinalCitations, RIG_REPORT,
} from './tools';
export type {
  DelegateToolOpts,
  KeylessSearchOptions,
  PlanToolOpts, PlanPromptInput,
  ReportToolOpts, Reports,
  PlanResult, PlanIntent, ResearchTask,
  SearchProvider, SearchResult,
  Output, OutputOptions, WeaveSource,
} from './tools';

// The retrieval contract, the source every ability subclasses, and the admission every search tool runs.
export type { Resource, Chunk, ScoredChunk, ScoredResult, Reranker, Embedder, EmbeddingPooling } from './retrieval';
export { Source } from './source';
export { admitChunks } from './admission';
export type { AdmitOpts, AdmitResult, AdmitSelect, AdmittedPassage } from './admission';
// The service contract, consumer side: the closed set, the bound bag, the one accessor. Node-free; the
// providers that fulfil it are `@lloyal-labs/rig/node`'s.
export { SERVICES, Services, service } from './services';
export type { ServiceMap, Service, Trunk } from './services';
// The ability contract: what a signed package declares and constructs, and the contexts its factory reads.
export { AbilityRegistryCtx } from './ability-types';
export type {
  Ability, AbilityManifest, AbilityProtocol, AbilityHints, AbilityRegistry, AbilityFactory, AbilityState,
  AgentRenderCtx, ExamplesRenderCtx, SkillTemplateFn, ExamplesTemplateFn, ConfigFlow,
} from './ability-types';
export { AbilityConfigStoreCtx } from './ability-config';
export type { AbilityConfigStore } from './ability-config';

// Chunking helpers (platform-agnostic — linkedom is pure JS).
// Shared by the web ability's source and the rig-resident fetch_page tool.
export { chunkFetchedPages, chunkHtml } from './sources/chunking';
export type { FetchedPage } from './sources/chunking';

// Retrieval primitives shared by every source ability (pure TS — RN-safe).
export { BM25Index } from './bm25';
export type { Bm25Opts, Bm25Hit } from './bm25';
export { fitChunks, splitParagraphs, DEFAULT_CHUNK_TOKENS } from './resources/fit';
export type { FitOpts } from './resources/fit';
export { mergeRanges, subtractRanges } from './ranges';
export { loadDocuments } from './resources/documents';
export type { Document } from './resources/documents';

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
// The install on the wire: the steps a view draws, the commands a reader sends. Node-free.
export { isInstallCommand } from './install-protocol';
export type { InstallStep, InstallStepEvent, InstallCommand } from './install-protocol';
// The machine gate: can this box hold this model? Node-free — the box's memory is passed in.
export { checkMachine, refusalMessage, gb, MACHINE_CLASS_FLOOR_BYTES } from './machine';
export type { MachineClass, MachineVerdict } from './machine';
// A harness's configuration as data: one declaration per key, the model block shipped.
export { defineConfig, modelSettings, mergeConfig, CONFIG_VERSION } from './config';
export type { ConfigKey, ConfigTable, ConfigTier, ConfigOf, OriginOf, CliOf, YmlOf, ModelFamily } from './config';
export { createGrantStore } from './grant-store';
export { createAbilityRegistry, ability, abilityRequiresConfig } from './registry';
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
// The Runner substrate (hdk#109) — the runner ↔ harness seam, generic over
// the harness's own config/origin shapes. Node-free (RN-safe); the disk
// mechanics live in ./node.
export {
  RunnerCtx,
  makeEdgeRunner,
  makeServedRunner,
  markSession,
  rung,
} from './runner';
export type {
  Runner,
  RunnerDevOpts,
  RunnerConfigOpts,
  BaseHarnessConfig,
  ConfigOriginValue,
  ConfigPatch,
  SaveResult,
  LoadedConfig,
} from './runner';
// The harness's boot, in initAgents's shape; the wire it hands back; the vocabulary rig owns on it.
export { initializeHarness } from './initialize-harness';
export type { Initialized, InitializeHarnessOpts } from './initialize-harness';
export { useWire } from './wire';
export { configLoaded, configUpdated } from './settings-protocol';
export type { RunCommand, SettingsCommand, SettingsEvent } from './settings-protocol';
// The execution owner: one live operation per session, accepted at once and sequenced in its loop.
export { useExecution, OperationFailure } from './execution';
export type { Execution } from './execution';
// The wire's attachment claims, checked once for every product.
export { admitted } from './admitted';
export type { Admitted } from './admitted';
// The dispatcher: one loop, one handler per command type, the groups' handlers merged.
export { serveCommands, serveDefaults } from './serve-commands';
export type { CommandGroup, Handlers, Flow, ServeCommandsOptions, ServeDefaultsDeps } from './serve-commands';
export { renderSpine, renderAgentPreamble } from './spine-render';
export type { RenderSpineOptions } from './spine-render';
// The sources a run can research with, what each advertises, and what each covers for a question.
export { participating, abilityToc } from './participating';
export { coverage, sourceKey, sourceOf } from './coverage';
export type { CoverageOptions, CoveragePromptInput, Coverage } from './coverage';
export { buildAbilityDescriptors, redactAbilityConfig } from './ability-descriptors';
export type { AbilityDescriptor } from './ability-descriptors';
export type { HostResourcesEvent } from './host-resources';
export { bufferedCommandSignal } from './buffered-command-signal';
export { HarnessExit } from './harness-exit';
