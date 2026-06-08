import { Source } from "@lloyal-labs/lloyal-agents";
import type { Tool } from "@lloyal-labs/lloyal-agents";
import { WikipediaSearchTool } from "./tools/search";
import { WikipediaFetchTool } from "./tools/fetch";

/**
 * Wikipedia-backed data source: a `wikipedia_search` tool that hits the
 * MediaWiki opensearch endpoint to find candidate articles, and a
 * `wikipedia_fetch` tool that fetches a single article's summary from the
 * REST API. No auth required — Wikipedia's public REST is open-access.
 *
 * The source intentionally exposes no reranker integration: Wikipedia
 * search ranks server-side by relevance, and the summary endpoint returns
 * an already-curated lead paragraph + extract. Agents work with the
 * structured response directly.
 */
export class WikipediaSource extends Source {
  readonly name = "wikipedia";

  private _tools: Tool[];

  constructor(opts?: WikipediaSourceOpts) {
    super();
    const userAgent =
      opts?.userAgent ?? "@lloyal-labs/wikipedia-app/1.0 (https://lloyal.ai)";
    this._tools = [
      new WikipediaSearchTool({ userAgent }),
      new WikipediaFetchTool({ userAgent }),
    ];
  }

  get tools(): Tool[] {
    return this._tools;
  }
}

/** Configuration for {@link WikipediaSource}. */
export interface WikipediaSourceOpts {
  /**
   * Override the `User-Agent` header sent on every request. Wikipedia's
   * API policy asks for a descriptive User-Agent that identifies the
   * caller — keep the default unless you have a reason to override.
   */
  userAgent?: string;
}
