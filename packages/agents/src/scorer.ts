/**
 * Entailment scorer — scores texts against an original query to
 * maintain semantic coherence across recursive agent pipelines.
 *
 * The pool's one dependency on retrieval: a tool's `ToolContext` carries one,
 * and a source (in `@lloyal-labs/rig`) builds one from its reranker per
 * invocation. Immutable once created — safe to share across concurrent pools.
 *
 * ## Three queries in play
 *
 * | Concept            | Scope                    | Field name in code                        |
 * |--------------------|--------------------------|-------------------------------------------|
 * | **Tool query**     | Per tool call            | scored by the tool's own reranker pass |
 * | **Agent task**     | Per agent lifetime       | `reference` param of scoreSimilarityBatch |
 * | **Original query** | Per run, the root query  | Captured in closure by the source's scorer |
 *
 * - `scoreEntailmentBatch` scores against the **original query** (steering boundaries)
 * - exploit mode (`admitChunks`) takes `min(tool-query score, scoreEntailmentBatch)` — one extra pass, never two
 * - `scoreSimilarityBatch` scores against an arbitrary **reference** (echo detection uses agent task)
 *
 * **Unit.** Every score this interface returns is the reranker's LOGIT
 * difference: unbounded, centred on zero, positive meaning "yes". Not a 0–1
 * similarity; any threshold over these numbers is in logits.
 *
 * Conflating these produces wrong scores. When adding new scoring
 * methods or trace events, use the field names from this table.
 *
 * @category Agents
 */
export interface EntailmentScorer {
  /** Score texts against the original query. One score per text, in the
   *  scorer's unit (see the interface doc). */
  scoreEntailmentBatch(texts: string[]): Promise<number[]>;
  /** Score texts against an arbitrary reference string (echo detection uses
   *  the agent task). One score per text, in the scorer's unit. */
  scoreSimilarityBatch(reference: string, texts: string[]): Promise<number[]>;
  /** Threshold gate — returns true if the score is high enough to proceed. */
  shouldProceed(score: number): boolean;
}

/** No-op scorer — all scores 1.0, all proceed. Used when no reranker is available. */
export const NULL_SCORER: EntailmentScorer = {
  scoreEntailmentBatch: async (texts) => texts.map(() => 1),
  scoreSimilarityBatch: async (_ref, texts) => texts.map(() => 0),
  shouldProceed: () => true,
};
