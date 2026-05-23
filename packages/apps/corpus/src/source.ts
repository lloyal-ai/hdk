import { Source } from "@lloyal-labs/lloyal-agents";
import type { Tool } from "@lloyal-labs/lloyal-agents";
import type { Resource, Chunk, Reranker } from "@lloyal-labs/rig";
import { SearchTool } from "./tools/search";
import { ReadFileTool } from "./tools/read-file";
import { GrepTool } from "./tools/grep";

/** Data for rendering the corpus-research per-spawn content. */
export interface CorpusPromptData {
  toc: string;
}

/** Configuration for {@link CorpusSource}. */
export interface CorpusSourceOpts {
  /** GrepTool configuration. */
  grep?: { maxResults?: number; lineMaxChars?: number };
  /** ReadFileTool configuration. */
  readFile?: { defaultMaxLines?: number };
}

/**
 * Corpus-backed data source: semantic `search` (reranker-scored), `read_file`,
 * and `grep` over a local document corpus.
 *
 * Constructed already-bound (RFC §6.3 — no `bind()`): the app factory loads +
 * tokenizes the chunks through the reranker, then hands them here. Because
 * `search` needs the reranker, a reranker is required at construction.
 */
export class CorpusSource extends Source<{ reranker: Reranker }, Chunk> {
  private _chunks: Chunk[];
  private _tools: Tool[];

  /** @inheritDoc */
  readonly name = "corpus";

  /**
   * @param resources - Loaded file resources for `read_file` and `grep`.
   * @param chunks - Chunks already tokenized by `reranker` (done in the factory).
   * @param reranker - Cross-encoder for `search` scoring.
   * @param opts - grep / read_file configuration.
   */
  constructor(
    resources: Resource[],
    chunks: Chunk[],
    reranker: Reranker,
    opts?: CorpusSourceOpts,
  ) {
    super();
    this._chunks = chunks;
    this._reranker = reranker;
    this._tools = [
      new SearchTool(chunks, reranker),
      new ReadFileTool(resources, { ...opts?.readFile, chunks }),
      new GrepTool(resources, opts?.grep),
    ];
  }

  /** @inheritDoc */
  get tools(): Tool[] {
    return this._tools;
  }

  /**
   * TOC (file → top-level headings) for the harness to render into the
   * corpus research spawn's task content. Agents discover relevant content
   * through their tools, not pre-scored prompt suggestions.
   */
  promptData(): CorpusPromptData {
    return { toc: this._buildToc() };
  }

  private _buildToc(): string {
    const byFile = new Map<string, string[]>();
    for (const c of this._chunks) {
      if (!c.section) continue;
      const isTopLevel = !c.section.includes(" > ");
      if (!isTopLevel) continue;
      const topics = byFile.get(c.resource) ?? [];
      if (!topics.includes(c.heading)) topics.push(c.heading);
      byFile.set(c.resource, topics);
    }
    for (const c of this._chunks) {
      if (!byFile.has(c.resource)) byFile.set(c.resource, []);
    }
    const lines: string[] = [];
    for (const [file, topics] of byFile) {
      lines.push(topics.length > 0 ? `${file} (topics: ${topics.join(", ")})` : file);
    }
    return lines.join("\n");
  }
}
