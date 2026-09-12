import type { Reranker } from '../tools/types';

/**
 * The reranker a source needs at construction — corpus sources to tokenize
 * chunks, web sources for fetch-page chunk scoring. Ability factories read
 * it from `RerankerCtx` and pass it in; orchestration config (prompts,
 * maxTurns, tools) belongs to the pool, not to the source.
 *
 * @category Rig
 */
export interface SourceContext {
  /** Reranker instance for chunk tokenization and scoring */
  reranker: Reranker;
}
