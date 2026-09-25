import { call } from "effection";
import type { Operation } from "effection";
import { Tool } from "@lloyal-labs/lloyal-agents";
import { admitChunks } from "@lloyal-labs/rig";
import type { JsonSchema, ToolContext, ToolLifecycleHooks } from "@lloyal-labs/lloyal-agents";
import { chunkHtml } from "@lloyal-labs/rig";
import type { Reranker } from "@lloyal-labs/rig";
import { urlDedup, trimmed } from "./guards";

/**
 * Fetch a web page and return the parts of it that answer a query.
 *
 * Fetches with a timeout, extracts the article body via linkedom + Readability, chunks the article on
 * heading boundaries (the same shape as corpus `parseMarkdown`) and hands the chunks to the platform's
 * admission, which scores them against the query on the reranker and selects within the token budget.
 * Only verbatim chunks come back — never a summary, never a truncation. The reranker is the ability's
 * requirement, so there is no path without one; the query is the tool's, so there is no call without one.
 *
 * @category Rig
 */
export class FetchPageTool extends Tool<{ url: string; query: string }> {
  readonly name = "fetch_page";
  readonly protected = false;
  // Network-only (HTTP fetch; the reranker runs on its own context) — no main-context op, so it runs off the
  // loop fiber under concurrent dispatch. See Tool.fanout.
  readonly fanout = true;
  /** This tool's gate: a URL already attended is not fetched again. Scope is the harness's. */
  readonly hooks: ToolLifecycleHooks = { beforeDispatch: [urlDedup] };
  readonly description =
    "Fetch a web page and return the sections most relevant to a query, verbatim. Returns the title and the selected sections.";
  readonly parameters: JsonSchema = {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
      query: { type: "string", description: "What to look for in this page — the sections returned are the ones that answer it" },
    },
    required: ["url", "query"],
  };

  private _reranker: Reranker;
  private _topK: number;
  private _timeout: number;
  private _tokenBudget: number;

  constructor(reranker: Reranker, opts?: { topK?: number; timeout?: number; tokenBudget?: number }) {
    super();
    this._reranker = reranker;
    this._topK = opts?.topK ?? 5;
    this._timeout = opts?.timeout ?? 10_000;
    this._tokenBudget = opts?.tokenBudget ?? 2048;
  }

  *execute(args: { url: string; query: string }, context?: ToolContext): Operation<unknown> {
    const url = trimmed(args.url);
    if (!url) return { error: "url must not be empty" };

    // A PDF is refused for what it is, whatever else the call carried: the way in is to attach the file.
    const lowerUrl = url.toLowerCase();
    if (lowerUrl.endsWith(".pdf") || lowerUrl.includes(".pdf?") || lowerUrl.includes(".pdf#")) {
      return {
        error: "This is a PDF, which fetch_page cannot read. Ask the user to attach the file to the conversation.",
        url,
      };
    }
    const query = trimmed(args.query);
    if (!query) return { error: "query must not be empty — say what to look for in this page" };

    const reranker = this._reranker;
    const topK = this._topK;
    const timeout = this._timeout;
    const tokenBudget = this._tokenBudget;

    // Step 1: Fetch + readability (async)
    const fetched = yield* call(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; lloyal-agents/1.0)" },
          signal: controller.signal,
        });
      } catch (err) {
        return { error: `Fetch failed: ${(err as Error).message}`, url } as const;
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) return { error: `HTTP ${res.status} ${res.statusText}`, url } as const;

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/pdf")) {
        return {
          error: "This is a PDF, which fetch_page cannot read. Ask the user to attach the file to the conversation.",
          url,
        } as const;
      }

      const html = await res.text();

      const { parseHTML } = await import("linkedom");
      const { document } = parseHTML(html);
      if (!document || !document.documentElement) return { error: "Could not parse the page's HTML", url } as const;

      const { Readability } = await import("@mozilla/readability");
      const article = new Readability(document).parse();
      if (!article || !article.content) return { error: "No article body was extracted from this page", url } as const;

      return { url, title: article.title ?? "", articleHtml: article.content } as const;
    });
    if ("error" in fetched) return fetched;

    // Step 2: chunk the article structurally, then hand the chunks to the platform's admission. `admitChunks`
    // owns scoring, explore/exploit dual scoring, the budgeted selection, and the trace events that make the
    // funnel observable — this tool owns only what is page-shaped: fetching, chunking, tokenizing fresh chunks,
    // and rendering the result. The result is what admission selected and nothing beside it: no extractor
    // excerpt, which would ride past the budget.
    const chunks = yield* call(() => chunkHtml(fetched.articleHtml, url, fetched.title));
    if (chunks.length === 0) return { url, title: fetched.title, content: "", chunks: 0 };

    yield* call(() => reranker.tokenizeChunks(chunks));
    const admitted = yield* admitChunks(reranker, chunks, query, context, {
      tool: "fetch_page",
      url,
      select: { mode: "budget", topK, tokenBudget },
      traceChunkList: true,
    });
    const passages = admitted.passages ?? [];
    const alsoOnPage = admitted.alsoOnPage ?? [];
    return {
      url,
      title: fetched.title,
      content: passages.map((c) => c.text).join("\n\n---\n\n"),
      chunks: passages.length,
      ...(alsoOnPage.length > 0 ? { alsoOnPage } : {}),
    };
  }
}
