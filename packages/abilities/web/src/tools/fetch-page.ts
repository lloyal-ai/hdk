import { call } from "effection";
import type { Operation } from "effection";
import { Tool, admitChunks } from "@lloyal-labs/lloyal-agents";
import type { JsonSchema, ToolContext } from "@lloyal-labs/lloyal-agents";
import { chunkHtml } from "@lloyal-labs/rig";
import type { Reranker } from "@lloyal-labs/rig";

/**
 * Fetch a web page and extract readable article content.
 *
 * Uses the Fetch API with a 10-second timeout, then extracts the
 * article body via linkedom + Readability.
 *
 * When a reranker is set (via {@link setReranker}) and the agent provides
 * a `query` argument, the article HTML is structurally chunked on heading
 * boundaries (same pattern as corpus `parseMarkdown`) and scored against
 * the query. Only the top-K most relevant verbatim chunks are returned —
 * reducing KV pressure without lossy summarization. The reranker runs on
 * its own `llama_context`, consuming zero inference KV.
 *
 * Without a reranker or query, returns the full content truncated to
 * `maxChars` (default 6000). Fully backward compatible.
 *
 * @category Rig
 */
export class FetchPageTool extends Tool<{ url: string; query?: string }> {
  readonly name = "fetch_page";
  readonly protected = false;
  // Network-only (HTTP fetch; optional reranker runs on its own context) — no
  // main-context op, so it runs off the loop fiber under concurrent dispatch.
  // See Tool.fanout.
  readonly fanout = true;
  readonly description =
    "Fetch a web page and extract its article content. Returns readable text with title and excerpt. Pass a query to get only the most relevant sections.";
  readonly parameters: JsonSchema = {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
      query: {
        type: "string",
        description:
          "What to look for in this page (optional — improves relevance of returned content)",
      },
    },
    required: ["url"],
  };

  private _maxChars: number;
  private _reranker: Reranker | null = null;
  private _topK: number;
  private _timeout: number;
  private _tokenBudget: number;

  constructor(opts?: {
    maxChars?: number;
    topK?: number;
    timeout?: number;
    tokenBudget?: number;
  }) {
    super();
    this._maxChars = opts?.maxChars ?? 6000;
    this._topK = opts?.topK ?? 5;
    this._timeout = opts?.timeout ?? 10_000;
    this._tokenBudget = opts?.tokenBudget ?? 2048;
  }

  /** Inject reranker for chunk scoring. Called by the source at construction. */
  setReranker(reranker: Reranker): void {
    this._reranker = reranker;
  }

  *execute(
    args: { url: string; query?: string },
    context?: ToolContext,
  ): Operation<unknown> {
    const url = args.url?.trim();
    if (!url) return { error: "url must not be empty" };

    // Cross-agent dedup: another worker in this pool already fetched this URL
    if (context?.peerHistory?.some(h => {
      if (h.name !== 'fetch_page') return false;
      try {
        const prev = (JSON.parse(h.args) as { url?: string }).url;
        return prev === url;
      } catch { return false; }
    })) {
      return { error: 'Resource unavailable. Try a different URL.' };
    }

    // Early reject PDF URLs
    const lowerUrl = url.toLowerCase();
    if (
      lowerUrl.endsWith(".pdf") ||
      lowerUrl.includes(".pdf?") ||
      lowerUrl.includes(".pdf#")
    ) {
      return {
        error:
          "PDF documents cannot be extracted. Try searching for an HTML version of this content.",
        url,
      };
    }

    const maxChars = this._maxChars;
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
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; lloyal-agents/1.0)",
          },
          signal: controller.signal,
        });
      } catch (err) {
        return {
          error: `Fetch failed: ${(err as Error).message}`,
          url,
        } as const;
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok)
        return { error: `HTTP ${res.status} ${res.statusText}`, url } as const;

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/pdf")) {
        return {
          error:
            "PDF documents cannot be extracted. Try searching for an HTML version of this content.",
          url,
        } as const;
      }

      const html = await res.text();

      const { parseHTML } = await import("linkedom");
      const { document } = parseHTML(html);

      if (!document || !document.documentElement) {
        return { url, content: "[Could not parse HTML]" } as const;
      }

      const { Readability } = await import("@mozilla/readability");
      const article = new Readability(document).parse();

      if (!article)
        return { url, content: "[Could not extract article content]" } as const;

      return {
        url,
        title: article.title ?? "",
        content: article.textContent ?? "",
        articleHtml: article.content ?? "",
        excerpt: article.excerpt ?? "",
      } as const;
    });

    // Early return on error or no article
    if ("error" in fetched) return fetched;
    if (!fetched.articleHtml) {
      let content = fetched.content;
      if (content.length > maxChars)
        content = content.slice(0, maxChars) + "\n\n[truncated]";
      return {
        url: fetched.url,
        title: fetched.title,
        content,
        excerpt: fetched.excerpt,
      };
    }

    // Step 2: Reranker path — chunk HTML structurally, then hand the chunks
    // to the platform's admission pipeline. `admitChunks` owns scoring,
    // explore/exploit dual scoring, the budgeted selection, and the trace
    // events that make the funnel observable (rerank:start/end,
    // entailment:content:exploit) — this tool owns only what is page-shaped:
    // fetching, chunking, tokenizing fresh chunks, and rendering the result.
    if (reranker && args.query) {
      const chunks = yield* call(() =>
        chunkHtml(fetched.articleHtml, url, fetched.title),
      );

      if (chunks.length > 0) {
        yield* call(() => reranker.tokenizeChunks(chunks));

        const admitted = yield* admitChunks(reranker, chunks, args.query, context, {
          tool: "fetch_page",
          url,
          select: { mode: "budget", topK, tokenBudget },
          traceChunkList: true,
        });

        if (admitted.passages!.length > 0) {
          return {
            url,
            title: fetched.title,
            content: admitted.passages!.map((c) => c.text).join("\n\n---\n\n"),
            chunks: admitted.passages!.length,
            ...(admitted.alsoOnPage!.length > 0 ? { alsoOnPage: admitted.alsoOnPage } : {}),
          };
        }
      }
    }

    // Fallback: return full content, truncated
    let content = fetched.content;
    if (content.length > maxChars) {
      content = content.slice(0, maxChars) + "\n\n[truncated]";
    }
    return { url, title: fetched.title, content, excerpt: fetched.excerpt };
  }
}
