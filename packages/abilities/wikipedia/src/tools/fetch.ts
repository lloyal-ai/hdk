import type { Operation } from "effection";
import { call } from "effection";
import { Tool, ToolRetryError } from "@lloyal-labs/lloyal-agents";
import type { JsonSchema, ToolLifecycleHooks } from "@lloyal-labs/lloyal-agents";
import { articleKey, titleDedup, trimmed } from "./guards";
import { transient } from "./http";

/**
 * Fetch a Wikipedia article's summary — title, lead paragraph, extract,
 * canonical URL, and a few metadata fields. Uses the REST `page/summary`
 * endpoint, which returns the curated lead content rather than the full
 * article wikitext.
 *
 * Endpoint shape:
 *   https://en.wikipedia.org/api/rest_v1/page/summary/<title>
 *   Returns JSON: { title, displaytitle, extract, content_urls, ... }
 */
export class WikipediaFetchTool extends Tool<{ title: string }> {
  readonly name = "wikipedia_fetch";
  readonly protected = false;
  // Network-only (MediaWiki REST) — issues no op on the main llama_context, so
  // it runs off the loop fiber under concurrent dispatch. See Tool.fanout.
  readonly fanout = true;
  /** This tool's gate: an article already attended is not fetched again. Scope is the harness's. */
  readonly hooks: ToolLifecycleHooks = { beforeDispatch: [titleDedup] };
  readonly description =
    "Fetch the summary (lead paragraph + extract) of a single Wikipedia article by exact title. Use the title returned by wikipedia_search. Returns the curated lead content, not the full article wikitext.";
  readonly parameters: JsonSchema = {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "Exact article title as returned by wikipedia_search (case + spelling sensitive). Spaces are OK; the tool URL-encodes them.",
      },
    },
    required: ["title"],
  };

  private _userAgent: string;

  constructor(opts: { userAgent: string }) {
    super();
    this._userAgent = opts.userAgent;
  }

  *execute(args: { title: string }): Operation<unknown> {
    const title = trimmed(args.title);
    if (!title) return { error: "title must not be empty" };

    // Wikipedia's REST encodes spaces as underscores in the canonical path.
    // `articleKey` is that same normalisation, and `title_dedup` reads it too,
    // so the gate and the fetch always agree on what one article is.
    const path = encodeURIComponent(articleKey(title)!);
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${path}`;

    let payload: unknown;
    try {
      payload = yield* call(async () => {
        const res = await fetch(url, {
          headers: {
            "User-Agent": this._userAgent,
            Accept: "application/json",
          },
        });
        // A 404 is an answer about the article, not weather: the model should
        // read it and pick another title.
        if (res.status === 404) {
          return null;
        }
        const weather = transient(res);
        if (weather) throw weather;
        if (!res.ok) {
          throw new Error(`Wikipedia REST HTTP ${res.status} ${res.statusText}`);
        }
        return res.json();
      });
    } catch (err) {
      // Rate limiting is the pool's to wait out, not the model's to read.
      if (err instanceof ToolRetryError) throw err;
      return {
        error: `wikipedia_fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (payload === null) {
      return {
        title,
        error: "Article not found. Use the exact title from wikipedia_search.",
      };
    }

    const p = payload as Record<string, unknown>;
    const contentUrls = (p.content_urls ?? {}) as Record<string, Record<string, string>>;
    // The REST `page/summary` payload already carries the article's lead image —
    // `thumbnail` (~320px) for cards, `originalimage` at full resolution. Surface
    // both so a view can render the article visually; absent for image-less pages.
    const thumbnail = p.thumbnail as { source?: unknown } | undefined;
    const originalimage = p.originalimage as { source?: unknown } | undefined;

    return {
      title: typeof p.title === "string" ? p.title : title,
      displayTitle:
        typeof p.displaytitle === "string" ? stripHtml(p.displaytitle) : undefined,
      description: typeof p.description === "string" ? p.description : undefined,
      extract: typeof p.extract === "string" ? p.extract : "",
      type: typeof p.type === "string" ? p.type : undefined,
      url: contentUrls.desktop?.page ?? contentUrls.mobile?.page ?? "",
      thumbnail: typeof thumbnail?.source === "string" ? thumbnail.source : undefined,
      image: typeof originalimage?.source === "string" ? originalimage.source : undefined,
      lang: typeof p.lang === "string" ? p.lang : "en",
    };
  }
}

/** Strip HTML tags from Wikipedia's `displaytitle` field. */
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}
