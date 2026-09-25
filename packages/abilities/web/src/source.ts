import type { Operation } from "effection";
import { Source } from "@lloyal-labs/rig";
import type { Tool, ToolContext } from "@lloyal-labs/lloyal-agents";
import type { Chunk, Reranker, SearchProvider } from "@lloyal-labs/rig";
import { chunkFetchedPages } from "@lloyal-labs/rig";
import type { FetchedPage } from "@lloyal-labs/rig";
import { WebSearchTool } from "./tools/web-search";
import { FetchPageTool } from "./tools/fetch-page";

// ── BufferingFetchPage ───────────────────────────────────────

/**
 * Thin wrapper over {@link FetchPageTool} that buffers fetched content
 * for post-use reranking via {@link WebSource.getChunks}.
 */
class BufferingFetchPage extends FetchPageTool {
  private _buffer: FetchedPage[];
  private _urlCache = new Map<string, unknown>();

  constructor(buffer: FetchedPage[], reranker: Reranker, opts?: { topK?: number; timeout?: number; tokenBudget?: number }) {
    super(reranker, opts);
    this._buffer = buffer;
  }

  *execute(args: { url: string; query: string }, context?: ToolContext): Operation<unknown> {
    const cached = this._urlCache.get(args.url);
    if (cached) return cached;

    const result = yield* super.execute(args, context);
    this._urlCache.set(args.url, result);

    const r = result as Record<string, unknown>;
    if (typeof r?.content === "string" && r.content !== "") {
      this._buffer.push({
        url: (r.url as string) || args.url,
        title: (r.title as string) || "",
        text: r.content as string,
      });
    }
    return result;
  }
}

// ── WebSource ────────────────────────────────────────────────

/** Configuration for {@link WebSource}. */
export interface WebSourceOpts {
  /** The reranker every `fetch_page` scores on — read with `service('reranker')` in the ability factory and
   *  handed here at construction: the source is born bound, there is no separate `bind` step. */
  reranker: Reranker;
  /** Max search results returned to agents. @default 8 */
  topN?: number;
  /** FetchPageTool configuration. */
  fetch?: {
    /** Top-K reranked chunks returned. @default 5 */
    topK?: number;
    /** Fetch timeout in ms. @default 10000 */
    timeout?: number;
    /** Reranker token budget for chunk selection. @default 2048 */
    tokenBudget?: number;
  };
}

/**
 * Web-backed data source: {@link WebSearchTool} (search) + {@link FetchPageTool} (fetch, extract, select by
 * query on the reranker). Fetched content is buffered for post-use reranking via {@link getChunks}.
 *
 * Constructed already-bound to its reranker (no `bind()` step). No orchestration, no prompts, no `node:fs`.
 */
export class WebSource extends Source<Chunk> {
  private _buffer: FetchedPage[] = [];
  private _fetchPage: BufferingFetchPage;
  private _webSearch: WebSearchTool;

  /** @inheritDoc */
  readonly name = "web";

  constructor(provider: () => Operation<SearchProvider>, opts: WebSourceOpts) {
    super();
    this._reranker = opts.reranker;
    this._fetchPage = new BufferingFetchPage(this._buffer, opts.reranker, opts.fetch);
    this._webSearch = new WebSearchTool(provider, opts.topN);
  }

  /** @inheritDoc */
  get tools(): Tool[] {
    return [this._webSearch, this._fetchPage];
  }

  /** @inheritDoc */
  getChunks(): Chunk[] {
    return chunkFetchedPages(this._buffer);
  }
}
