import type { Operation } from "effection";
import { call } from "effection";
import { Tool } from "@lloyal-labs/lloyal-agents";
import type { JsonSchema } from "@lloyal-labs/lloyal-agents";

/**
 * Wikipedia opensearch — given a query, returns up to N article titles +
 * one-line descriptions + URLs. Uses MediaWiki's `opensearch` action,
 * which is the same endpoint that powers Wikipedia's search autocomplete.
 *
 * Endpoint shape:
 *   https://en.wikipedia.org/w/api.php?action=opensearch&search=<q>&limit=<n>&format=json
 *   Returns [query, [titles], [descriptions], [urls]]
 */
export class WikipediaSearchTool extends Tool<{ query: string; limit?: number }> {
  readonly name = "wikipedia_search";
  readonly protected = false;
  readonly description =
    "Search Wikipedia for articles matching a query. Returns up to 10 article titles with one-line descriptions and URLs. Use this to discover candidate articles before fetching their summaries.";
  readonly parameters: JsonSchema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Search query — a topic, person, place, or concept. Wikipedia's search handles paraphrases reasonably.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Maximum number of results to return (default 10).",
      },
    },
    required: ["query"],
  };

  private _userAgent: string;

  constructor(opts: { userAgent: string }) {
    super();
    this._userAgent = opts.userAgent;
  }

  *execute(args: { query: string; limit?: number }): Operation<unknown> {
    const query = args.query?.trim();
    if (!query) return { error: "query must not be empty" };

    const limit = Math.min(Math.max(args.limit ?? 10, 1), 20);
    const url = new URL("https://en.wikipedia.org/w/api.php");
    url.searchParams.set("action", "opensearch");
    url.searchParams.set("search", query);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("namespace", "0");
    url.searchParams.set("format", "json");

    let payload: unknown;
    try {
      payload = yield* call(async () => {
        const res = await fetch(url.toString(), {
          headers: { "User-Agent": this._userAgent, Accept: "application/json" },
        });
        if (!res.ok) {
          throw new Error(`Wikipedia API HTTP ${res.status} ${res.statusText}`);
        }
        return res.json();
      });
    } catch (err) {
      return {
        error: `wikipedia_search failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!Array.isArray(payload) || payload.length < 4) {
      return { error: "wikipedia_search: unexpected response shape" };
    }
    const titles = Array.isArray(payload[1]) ? (payload[1] as string[]) : [];
    const descriptions = Array.isArray(payload[2]) ? (payload[2] as string[]) : [];
    const urls = Array.isArray(payload[3]) ? (payload[3] as string[]) : [];

    if (titles.length === 0) {
      return {
        query,
        count: 0,
        results: [],
        note: "No articles found. Try broader or differently-worded search terms.",
      };
    }

    const results = titles.map((title, i) => ({
      title,
      description: descriptions[i] ?? "",
      url: urls[i] ?? "",
    }));
    return { query, count: results.length, results };
  }
}
