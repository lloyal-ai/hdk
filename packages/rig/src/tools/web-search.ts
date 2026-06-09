/**
 * Tavily search provider — a {@link SearchProvider} implementation
 * consumed by the `lloyal/web` app's `web_search` tool.
 *
 * The provider is split from the tool: the tool class lives in
 * `@lloyal-labs/web-app` (the App protocol's unit of distribution);
 * this provider stays in rig so apps can swap providers without
 * vendoring the API client.
 */

import type { SearchProvider, SearchResult } from "./types";

export type { SearchProvider, SearchResult };

/**
 * {@link SearchProvider} implementation backed by the Tavily search API.
 *
 * Reads the API key from the constructor argument or the
 * `TAVILY_API_KEY` environment variable. Throws at search time
 * if no key is available.
 *
 * @category Rig
 */
export class TavilyProvider implements SearchProvider {
  readonly returnsFullContentMarkdown = false;
  private _apiKey: string;
  private _snippetMaxLength: number;

  constructor(apiKey?: string, opts?: { snippetMaxLength?: number }) {
    this._apiKey = apiKey || process.env.TAVILY_API_KEY || "";
    this._snippetMaxLength = opts?.snippetMaxLength ?? 500;
  }

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    if (!this._apiKey) throw new Error("TAVILY_API_KEY not set");
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this._apiKey}`,
      },
      body: JSON.stringify({ query, max_results: maxResults }),
    });
    if (!res.ok) throw new Error(`Tavily ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      results: { title: string; url: string; content: string; score?: number }[];
    };
    const max = this._snippetMaxLength;
    return data.results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet:
        r.content.length > max
          ? r.content.slice(0, max) + " […]"
          : r.content,
      score: r.score,
    }));
  }
}
