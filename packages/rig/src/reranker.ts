import { createContext } from "@lloyal-labs/lloyal.node";
import { Rerank } from "@lloyal-labs/sdk";
import type { SessionContext, KvCacheType, RerankInstruction } from "@lloyal-labs/sdk";
import { resource, call } from "effection";
import type { Operation } from "effection";
import type { Chunk, Reranker, ScoredResult } from "@lloyal-labs/lloyal-agents";

/**
 * Context-sizing overrides for {@link createReranker}. All optional; each
 * defaults inside `createReranker` (nSeqMax 10 · nCtx 4096 · nBatch derived).
 * Threaded through `provisionAbilityModels` (its `rerankerLoad`) so a harness can
 * tune the shared reranker without hand-loading it.
 */
export interface RerankerLoadOpts {
  /** Max parallel scoring sequences (default 10). */
  nSeqMax?: number;
  /** Reranker model context window (default 4096). */
  nCtx?: number;
  /** Decode batch size (default floor(nCtx / nSeqMax)). */
  nBatch?: number;
  /**
   * KV cache types for the reranker context. Both default to `q4_0` in this
   * version.
   *
   * The score is a logit difference, so KV precision bounds the smallest
   * score difference that is meaningful. Set these explicitly if you need a
   * known resolution.
   */
  typeK?: KvCacheType;
  typeV?: KvCacheType;
  /**
   * The scoring question. Defaults to retrieval relevance — the question every
   * ability asks today. Changing it changes what "relevant" means for EVERY
   * ability sharing this reranker, so it is a harness-level decision.
   */
  instruction?: RerankInstruction;
}

/**
 * Create a {@link Reranker} backed by a dedicated reranking model context,
 * as an Effection `resource()`.
 *
 * Loads a separate model (typically a cross-encoder) into its own KV cache
 * and exposes `score`, `scoreBatch`, `tokenizeChunks`, and `dispose`. The
 * returned `score` method yields {@link ScoredResult} batches as an async
 * iterable, mapping raw indices back to the original {@link Chunk} metadata.
 *
 * **Lifecycle.** The reranker owns its underlying `SessionContext` + `Rerank`
 * and disposes them transitively when the yielding scope exits (success,
 * error, or halt). The harness yields it once per process lifecycle and
 * publishes it on `RerankerCtx` so Ability factories can read it via
 * `RerankerCtx.expect()`. `dispose()` remains on the interface
 * for callers that manage teardown explicitly; it is idempotent so the
 * resource finally and an explicit call don't double-free.
 *
 * @param modelPath - Absolute path to the reranking model file (GGUF)
 * @param opts - Optional context sizing overrides ({@link RerankerLoadOpts})
 * @param opts.nSeqMax - Maximum parallel scoring sequences (default 10)
 * @param opts.nCtx - Context window size for the reranker model (default 4096)
 * @returns An Effection resource yielding a ready-to-use reranker
 *
 * @example
 * ```ts
 * const reranker = yield* createReranker(rerankerPath, { nSeqMax: 10, nCtx: 4096 });
 * yield* RerankerCtx.set(reranker);
 * // ... pool work ...
 * // reranker disposes automatically on scope exit
 * ```
 *
 * @category Rig
 */
export function createReranker(
  modelPath: string,
  opts?: RerankerLoadOpts,
): Operation<Reranker> {
  return resource(function* (provide) {
    // Default bumped 8→10: warm-trunk + per-query branch consume 2 leases in
    // the R3 Rerank composition, so leaves get N-2 slots; 10 keeps the leaf
    // budget at the prior default of 8.
    const nSeqMax = opts?.nSeqMax ?? 10;
    const nCtx = opts?.nCtx ?? 4096;
    const nBatch = opts?.nBatch ?? Math.floor(nCtx / nSeqMax);
    const ctx = yield* call(() => createContext({
      modelPath,
      nCtx,
      nSeqMax,
      nBatch,
      typeK: opts?.typeK ?? 'q4_0',
      typeV: opts?.typeV ?? 'q4_0',
    }));
    const rerank = yield* call(() =>
      Rerank.create(ctx as unknown as SessionContext, {
        nSeqMax,
        nCtx,
        instruction: opts?.instruction,
      }).catch((err: unknown) => {
        // A failing smoke test is a NORMAL configuration outcome now that the
        // instruction is a parameter. `Rerank.create` scrubs its own trunk and
        // decode-owner mark but does NOT own the context, so without this the
        // context leaks: the throw escapes before `provide`, so the
        // try/finally below never runs.
        ctx.dispose();
        throw err;
      }),
    );

    let disposed = false;
    const reranker: Reranker = {
    score(query: string, chunks: Chunk[]): AsyncIterable<ScoredResult> {
      const inner = rerank.score(
        query,
        chunks.map((c) => c.tokens),
        10,
      );
      return {
        [Symbol.asyncIterator](): AsyncIterator<ScoredResult> {
          const it = inner[Symbol.asyncIterator]();
          return {
            async next(): Promise<IteratorResult<ScoredResult>> {
              const { value, done } = await it.next();
              if (done)
                return {
                  value: undefined as unknown as ScoredResult,
                  done: true,
                };
              return {
                value: {
                  filled: value.filled,
                  total: value.total,
                  results: value.results.map((r) => ({
                    file: chunks[r.index].resource,
                    heading: chunks[r.index].heading,
                    section: chunks[r.index].section,
                    snippet: chunks[r.index].text.slice(0, 200),
                    score: r.score,
                    startLine: chunks[r.index].startLine,
                    endLine: chunks[r.index].endLine,
                  })),
                },
                done: false,
              };
            },
          };
        },
      };
    },

    scoreBatch(query: string, texts: string[]): Promise<number[]> {
      return rerank.scoreBatch(query, texts);
    },

    tokenize(text: string): Promise<number[]> {
      return rerank.tokenize(text);
    },

    async tokenizeChunks(chunks: Chunk[]): Promise<void> {
      // Tokenize in parallel — _tokenize is N-API AsyncWorker dispatch, so
      // Promise.all overlaps work across threadpool slots. Serial for-await
      // was a bottleneck on large corpora (1000+ chunks).
      const toks = await Promise.all(chunks.map((c) => rerank.tokenize(c.text)));
      for (let i = 0; i < chunks.length; i++) {
        chunks[i].tokens = toks[i];
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      rerank.dispose();
    },
    };

    try {
      yield* provide(reranker);
    } finally {
      reranker.dispose();
    }
  });
}
