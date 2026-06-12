import type { Operation } from "effection";
import { call } from "effection";
import { Tool } from "@lloyal-labs/lloyal-agents";
import type { JsonSchema } from "@lloyal-labs/lloyal-agents";

/**
 * __NAME___search — search the __NAME__ backend for items matching a query.
 *
 * Scaffolded with Wikipedia's opensearch endpoint so the app runs out of
 * the box. Replace `execute` with your real backend; keep the schema +
 * return shape so consumers stay compatible.
 */
export class __NAME_PASCAL__SearchTool extends Tool<{ query: string; limit?: number }> {
  readonly name = "__NAME___search";
  readonly protected = false;
  readonly description =
    "EDIT THIS: short, model-facing description of what __NAME___search does and when an agent should call it.";
  readonly parameters: JsonSchema = {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query." },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Maximum number of results to return (default 10).",
      },
    },
    required: ["query"],
  };

  *execute(args: { query: string; limit?: number }): Operation<unknown> {
    const query = args.query?.trim();
    if (!query) return { error: "query must not be empty" };
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 20);

    // STUB: Replace this Wikipedia call with a request to your real
    // __NAME__ backend. The return shape is what the agent sees.
    const url = new URL("https://en.wikipedia.org/w/api.php");
    url.searchParams.set("action", "opensearch");
    url.searchParams.set("search", query);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("namespace", "0");
    url.searchParams.set("format", "json");

    try {
      const payload = yield* call(async () => {
        const res = await fetch(url.toString(), {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        return res.json();
      });
      if (!Array.isArray(payload) || payload.length < 4) {
        return { error: "__NAME___search: unexpected response shape" };
      }
      const titles = Array.isArray(payload[1]) ? (payload[1] as string[]) : [];
      const descriptions = Array.isArray(payload[2]) ? (payload[2] as string[]) : [];
      const urls = Array.isArray(payload[3]) ? (payload[3] as string[]) : [];
      const results = titles.map((title, i) => ({
        id: title,
        title,
        description: descriptions[i] ?? "",
        url: urls[i] ?? "",
      }));
      return { query, count: results.length, results };
    } catch (err) {
      return {
        error: `__NAME___search failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
