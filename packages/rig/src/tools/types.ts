/**
 * Rig-resident tool adapter types: `SearchProvider` + `SearchResult` are HTTP-adapter shapes used only
 * by rig's keyless / Tavily provider.
 *
 * @packageDocumentation
 * @category Rig
 */

// ── Web search adapter ──────────────────────────────────

/**
 * A single result from a {@link SearchProvider} web search
 *
 * @category Rig
 */
export interface SearchResult {
  /** Page title */
  title: string;
  /** Page URL */
  url: string;
  /** Excerpt or snippet from the page content */
  snippet: string;
  /** Full page content — markdown when provider supports it, plain text otherwise */
  rawContent?: string;
  /** Provider-side relevance score (higher = more relevant) */
  score?: number;
}

/**
 * Adapter interface for web search backends
 *
 * Implement this to plug in a search provider (e.g. Tavily, Brave,
 * SerpAPI). Pass the implementation to {@link WebSearchTool}.
 *
 * @see {@link TavilyProvider} for the default implementation
 *
 * @category Rig
 */
export interface SearchProvider {
  /** Execute a web search and return ranked results */
  search(query: string, maxResults: number): Promise<SearchResult[]>;
  /** When true, rawContent on results is markdown with heading structure suitable for parseMarkdown chunking */
  readonly returnsFullContentMarkdown: boolean;
}
