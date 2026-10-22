/**
 * The retrieval contract: what is retrieved — a {@link Resource} and the {@link Chunk}s it is cut into — what
 * judges it, the {@link Reranker}, and what indexes it ahead of the question, the {@link Embedder}. Node-free,
 * so an ability and a harness read the same shapes from the root barrel; the bindings that make either from a
 * model file are the providers in `@lloyal-labs/rig/node`.
 *
 * @packageDocumentation
 * @category Rig
 */
import type { Operation } from 'effection';
import type { Attachment, AudioAdmission } from '@lloyal-labs/media';

/**
 * A loaded document available for search, read, and grep operations.
 *
 * Represents a single file (typically Markdown) loaded into memory.
 * Resources are chunked into {@link Chunk} instances for reranking.
 */
export interface Resource {
  /** File name (basename, not full path) used as the resource identifier. */
  name: string;
  /** Full text content of the file. */
  content: string;
}

/**
 * A scored passage within a {@link Resource}, used for reranking and retrieval.
 *
 * The `tokens` array is populated lazily by {@link Reranker.tokenizeChunks}
 * before scoring. Once tokenized, a chunk is bound to that reranker's
 * cross-encoder vocabulary — re-binding requires re-tokenization.
 */
export interface Chunk {
  /** Resource identifier (file name or URL) this chunk belongs to. */
  resource: string;
  /** Leaf section heading (e.g. "Recovery loop"). */
  heading: string;
  /** Hierarchical section path (e.g. "Agents > Lifecycle > Recovery loop"). Empty for web chunks. */
  section: string;
  /** Raw text content of the chunk. */
  text: string;
  /** Pre-tokenized representation for the reranker — empty until {@link Reranker.tokenizeChunks} runs. */
  tokens: number[];
  /** First line number (1-based) in the source resource. */
  startLine: number;
  /** Last line number (1-based) in the source resource. */
  endLine: number;
}

/**
 * A single chunk scored by the {@link Reranker} against a query.
 */
export interface ScoredChunk {
  /** Source filename containing the chunk. */
  file: string;
  /** Leaf section heading (e.g. "Recovery loop"). */
  heading: string;
  /** Hierarchical section path (e.g. "Agents > Lifecycle > Recovery loop"). Empty for web chunks. */
  section: string;
  /** First ~200 chars of chunk text — gives agents content at search time. */
  snippet: string;
  /** Relevance score (higher = more relevant). */
  score: number;
  /** Start line in the source file (1-indexed). */
  startLine: number;
  /** End line in the source file (1-indexed). */
  endLine: number;
}

/**
 * Progressive reranker output emitted during scoring.
 *
 * Streamed from {@link Reranker.score} as an async iterable, allowing
 * callers to report progress while scoring is in flight.
 */
export interface ScoredResult {
  /** Scored chunks accumulated so far, ordered by relevance. */
  results: ScoredChunk[];
  /** Number of chunks scored so far. */
  filled: number;
  /** Total number of chunks to score. */
  total: number;
}

/**
 * Cross-encoder reranker for scoring corpus chunks against a query.
 *
 * Abilities obtain the harness-wide reranker via `service('reranker')` at
 * factory time and hand it to their sources and tools at construction.
 * Implementations tokenize chunks up front via {@link tokenizeChunks},
 * then stream progressive results from {@link score}.
 */
export interface Reranker {
  /** Score chunks against a query, streaming progressive results. */
  score(query: string, chunks: Chunk[]): AsyncIterable<ScoredResult>;
  /**
   * Score raw text strings against a query in one batch.
   *
   * Returns logit-diff scores (`logit("yes") - logit("no")`, unbounded) in
   * input order. This is the log-odds of the reranker's ABSOLUTE yes/no
   * relevance judgment — `P(yes) = sigmoid(score)`, so 0 ≡ P 0.5 — the
   * monotone equivalent of the official Qwen3-Reranker two-token softmax.
   * Scores are thresholdable and comparable across queries to the extent of
   * the model's calibration (quantization adds noise at the extremes).
   */
  scoreBatch(query: string, texts: string[]): Promise<number[]>;
  /** Pre-tokenize chunks for subsequent scoring calls. */
  tokenizeChunks(chunks: Chunk[]): Promise<void>;
  /**
   * Tokenize an arbitrary text string through the reranker's tokenizer.
   * Use when consumers need to operate on tokens from the same vocabulary
   * as the chunks (e.g. BM25 first-stage scoring at query time).
   */
  tokenize(text: string): Promise<number[]>;
  /** Release reranker resources. */
  dispose(): void;
}

/** How an embedding model folds its token states into one vector — the model's own property, never a choice:
 *  a decoder-style encoder reads its last token, nomic-embed averages. The catalog carries it per entry. */
export type EmbeddingPooling = 'mean' | 'cls' | 'last';

/** What an embedder reads: text always; images, video and sound through a projector that reads them. */
export type Modality = 'text' | 'image' | 'video' | 'audio';

/** What an embedding can be for, as the model cards name the uses they train for. */
export const EMBEDDING_TASKS = [
  'search', 'question-answering', 'fact-checking', 'code-retrieval', 'classification', 'clustering', 'similarity',
] as const;

export type EmbeddingTask = (typeof EMBEDDING_TASKS)[number];

/** Which side of a task an input is on: what is asked, or what answers it. A symmetric task frames both alike. */
export type EmbeddingRole = 'query' | 'document';

/** The text a model wants before an input's own text for one task, as its card gives it: one for a query, one for
 *  a document, and one for a document with a title (`{title}` stands for it) when the task has a place for one. */
export interface TaskFraming {
  query: string;
  document: string;
  titled?: string;
}

/** A model's framings, by task: catalog data, like its pooling. */
export type EmbeddingFraming = Partial<Record<EmbeddingTask, TaskFraming>>;

/** One input to embed, as one vector: text and attachment roots (an image, a recording, a video or a window of
 *  one), in order, and what it is for. A bare string is one text part, a document for search. */
export type EmbeddingInput = string | {
  parts: readonly (string | Attachment)[];
  /** Search when absent. */
  task?: EmbeddingTask;
  /** A document when absent. Only framing reads it, so a model that declares none embeds either side as given. */
  role?: EmbeddingRole;
  /** A document's title, written where the task's framing has a place for one. */
  title?: string;
};

/**
 * The encoder a harness indexes with: one vector per input, in input order, L2-normalized so cosine similarity
 * is a dot product. An input is text and media together, as one vector: text around an image, a video's
 * frames beside its soundtrack.
 *
 * The caller says what an input is for, never how the model wants that written: the encoder frames each input's
 * text with the bound model's own framing for its task and role (`search_query: ` for nomic, an instruction line
 * for Qwen), and media alone goes unframed. A model that declares no framing embeds text as given.
 * Every call is serialized on the one context behind it, across callers, so concurrent calls answer the same
 * vectors they would in sequence. Each call is measured before anything runs: an input over the context, or
 * media the model cannot read, refuses the whole call, and the next call is unaffected. An Operation, like
 * everything a harness composes: leaving the scope abandons the wait, and the native work already submitted still
 * settles. The encoder lives as long as the scope that bound it.
 */
export interface Embedder {
  /** The length of every vector this encoder answers. */
  readonly dimension: number;
  /** The widths the model was trained to be cut to, widest first: what a vector index may compare at. */
  readonly dimensions: readonly number[];
  /** What the bound model reads. */
  readonly modalities: readonly Modality[];
  /** The admission a recording, or a video's soundtrack window, meets to be embedded; null when the model does not
   *  hear. A host keeps a clip's sound under it. */
  readonly audio: Readonly<AudioAdmission> | null;
  /** The tasks the bound model frames; an input for any other is refused. */
  readonly tasks: readonly EmbeddingTask[];
  embed(inputs: readonly EmbeddingInput[]): Operation<Float32Array[]>;
  /** What each input costs in cells, measured with nothing run: the context must hold that much to embed it. */
  measure(inputs: readonly EmbeddingInput[]): Operation<number[]>;
  /** Tokenize through the encoder's own vocabulary — what fits is measured in these. */
  tokenize(text: string): Operation<number[]>;
}
