import { call } from 'effection';
import type { Operation } from 'effection';
import { Tool, Trace, admitChunks } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema, ToolContext, Chunk } from '@lloyal-labs/lloyal-agents';
import type { Reranker, ScoredChunk } from '@lloyal-labs/rig';
import { pagesOf } from '@lloyal-labs/media';
import type { Attachment } from '@lloyal-labs/media';
import { pageCite, unknownDocument, NO_DOCUMENTS } from '../documents-index';
import type { DocumentsIndex } from '../documents-index';

/** The function from a run's attachments to their index (see `documentIndexer`). */
export type IndexFor = (attachments: readonly Attachment[]) => Promise<DocumentsIndex>;

/** How many passages a search returns: the top K within a token budget, the
 *  allowance `fetch_page` gives a page. No score floor: the reranker is a
 *  relative judge — its scale shifts from passage to passage and its verdict
 *  on an attached document's own text runs within a few logits of zero — so
 *  the best K are returned with their scores and the agent reads them. */
const DEFAULT_TOP_K = 5;
const DEFAULT_TOKEN_BUDGET = 2048;
/** First-stage cap: BM25 narrows to the top-K lexical matches before the
 *  cross-encoder, whose cost is linear in candidates. */
const DEFAULT_FIRST_STAGE_K = 100;

/** A hit as this ability returns it: the corpus shape plus where it is. */
export interface DocumentHit extends ScoredChunk {
  document: string;
  id: string;
  pageStart: number;
  pageEnd: number;
  /** `attachment://<id>/page/<pageStart>` — copied into report sources as-is. */
  cite: string;
}

/** Place a scored chunk in its document: title, id, pages, citation. */
export function locate(index: DocumentsIndex, hit: ScoredChunk): DocumentHit {
  const doc = index.documents.find((d) => d.id === hit.file);
  if (!doc) throw new Error(`search_documents: hit names ${hit.file}, which is not a document in the index`);
  const { pageStart, pageEnd } = pagesOf(doc.meta, hit.startLine, hit.endLine);
  return { ...hit, document: doc.meta.title, id: doc.id, pageStart, pageEnd, cite: pageCite(doc.attachment, pageStart) };
}

/**
 * Semantic search over the documents available to the run: BM25 first stage,
 * then the platform's admission pipeline (cross-encoder, top-K within a token
 * budget, trace events). What is document-shaped lives here: the per-call
 * index, the optional scope to one document, the pages on every hit — and the
 * stance: a document search always scores in explore mode. The run's exploit
 * stance exists to keep off-topic web pages out; an attached document is the
 * on-topic universe, and a min() with the original question would veto the
 * passage that answers a sub-question of it.
 */
export class SearchDocumentsTool extends Tool<{ query: string; document?: string }> {
  readonly name = 'search_documents';
  readonly protected = false;
  // Reranker (its own llama_context) + in-memory BM25 — no op on the MAIN
  // context, so it runs off the loop fiber under concurrent dispatch.
  readonly fanout = true;
  readonly description = 'Search the attached documents. Returns passages ranked by relevance, each with its document, line range and pages for read_document. Pass `document` to search one document only.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      document: { type: 'string', description: 'Document id or title, to search one document only' },
    },
    required: ['query'],
  };

  private readonly _indexFor: IndexFor;
  private readonly _reranker: Reranker;
  private readonly _topK: number;
  private readonly _tokenBudget: number;
  private readonly _firstStageK: number;

  constructor(indexFor: IndexFor, reranker: Reranker, opts?: { topK?: number; tokenBudget?: number; firstStageK?: number }) {
    super();
    this._indexFor = indexFor;
    this._reranker = reranker;
    this._topK = opts?.topK ?? DEFAULT_TOP_K;
    this._tokenBudget = opts?.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    this._firstStageK = opts?.firstStageK ?? DEFAULT_FIRST_STAGE_K;
  }

  *execute(args: { query: string; document?: string }, context?: ToolContext): Operation<unknown> {
    const query = args.query?.trim();
    if (!query) return { error: 'query must not be empty' };
    const index: DocumentsIndex = yield* call(() => this._indexFor(context?.attachments ?? []));
    if (index.documents.length === 0) return { error: NO_DOCUMENTS };
    const scope = args.document ? index.find(args.document) : undefined;
    if (args.document && !scope) return { error: unknownDocument(args.document, index) };
    const inScope = (c: Chunk): boolean => !scope || c.resource === scope.id;
    const pool = index.chunks.filter(inScope);

    const tw = yield* Trace.expect();
    let candidates = pool;
    if (index.bm25 && this._firstStageK < pool.length) {
      const bm25Start = performance.now();
      tw.write({
        traceId: tw.nextId(), parentTraceId: null, ts: bm25Start,
        type: 'bm25:start', query, candidateCount: pool.length, firstStageK: this._firstStageK,
      });
      const queryTokens: number[] = yield* call(() => this._reranker.tokenize(query));
      // The index spans every document; a scoped search keeps the hits in
      // scope and takes its K from those.
      const hits = index.bm25.score(queryTokens, scope ? index.chunks.length : this._firstStageK);
      candidates = hits.map((h) => index.chunks[h.index]).filter(inScope).slice(0, this._firstStageK);
      tw.write({
        traceId: tw.nextId(), parentTraceId: null, ts: performance.now(),
        type: 'bm25:end', candidateCount: pool.length, keptCount: candidates.length, durationMs: performance.now() - bm25Start,
      });
    }

    const admitted = yield* admitChunks(this._reranker, candidates, query, context ? { ...context, explore: true } : context, {
      tool: 'search_documents',
      select: { mode: 'budget', topK: this._topK, tokenBudget: this._tokenBudget },
    });
    // The budget decides how many; the hits keep their addresses. The
    // selection is a prefix of the ranking (every window has text), so the
    // first `passages.length` scored chunks are the passages, with lines.
    const kept = admitted.passages?.length ?? 0;
    return {
      hits: admitted.scored.slice(0, kept).map((h) => locate(index, h)),
      totalScored: admitted.totalScored,
    };
  }
}
