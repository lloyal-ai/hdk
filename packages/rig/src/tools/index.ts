/**
 * Rig — framework-level tools, search providers, and shared types.
 *
 * **Framework tools (consumed by harnesses):**
 * - {@link reportTool} / {@link ReportTool} — the standard terminal tool.
 * - {@link DelegateTool} — delegation primitive for sub-agent spawning.
 * - {@link PlanTool} — grammar-constrained query planner.
 *
 * **Search providers (consumed by apps' Source implementations):**
 * - {@link TavilyProvider} — Tavily-backed web search.
 * - {@link createKeylessSearchProvider} — keyless DuckDuckGo fallback.
 *
 * App-scoped Tool classes (`web_search`, `fetch_page`, `search`,
 * `read_file`, `grep`) live in `@lloyal-labs/{web,corpus}-app`, not
 * here — those are unit-of-distribution surfaces under the App
 * protocol, installed via `harness.dev install`.
 */

import { ReportTool } from './report';

export { TavilyProvider } from './web-search';
export type { SearchProvider, SearchResult } from './web-search';
export { createKeylessSearchProvider } from './keyless-search';
export type { KeylessSearchOptions } from './keyless-search';
export { ReportTool } from './report';
export { DelegateTool } from './delegate';
export type { DelegateToolOpts } from './delegate';
export type { Reranker, ScoredChunk, ScoredResult } from './types';
export { PlanTool, taskToContent } from './plan';
export type { PlanResult, PlanIntent, PlanToolOpts, ResearchTask } from './plan';

/**
 * Shared {@link ReportTool} instance — the conventional terminal tool.
 *
 * `ReportTool` is stateless, so one shared instance is reused across
 * pools. Pass it as the `terminal` of `agentPool` / `useAgent`. For a
 * custom description, construct your own via `new ReportTool({...})`.
 *
 * @category Rig
 */
export const reportTool = new ReportTool();
