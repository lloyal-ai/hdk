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
   * KV cache types. Default **f16** for both — the reranker's output is a logit
   * difference, and quantised KV is noise in exactly that quantity.
   *
   * Measured noise floor (six leaves given identical tokens must score
   * identically; the spread is the floor):
   * `q4_0` 1.270 · `q5_0` 0.813 · `q8_0` 0.122 · `f16` 0.004 logits.
   *
   * Lower this only under real memory pressure, and know what it costs: at
   * nCtx 4096 f16 is 448 MiB against q4_0's 126 MiB, and any calibrated
   * threshold whose margin was measured at f16 stops meaning anything. The old
   * q4_0 default put the floor ABOVE the boot canary's own `minGap` of 1.0.
   *
   * Re-measure with `npm run eval:reranker` if you change these.
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
      // Defaults to f16, NOT q4_0 — the reranker's whole output is a
      // fine-grained logit difference, and quantised KV puts noise into it.
      //
      // Measured on Qwen3-Reranker-0.6B (28 layers · 8 KV heads · head_dim 128
      // = 57,344 KV values/token) with six leaves forked from one parent and
      // given IDENTICAL tokens. They must score identically; the spread is the
      // noise floor:
      //
      //   q4_0  126 MiB @ nCtx 4096   spread 1.270    ← was the default
      //   q5_0  154 MiB               spread 0.813    (worse than q4_0 serially)
      //   q8_0  238 MiB               spread 0.122
      //   f16   448 MiB               spread 0.004
      //
      // At q4_0 the noise EXCEEDED the shipped boot canary's `minGap` of 1.0,
      // so the calibration gate was asserting a separation smaller than its own
      // measurement error, and any score threshold was inside the noise. The
      // +322 MiB buys a judge whose scores mean what they say.
      //
      // Reproduce with scripts/probe-scatter-vs-serial.ts <type>.
      typeK: opts?.typeK ?? 'f16',
      typeV: opts?.typeV ?? 'f16',
    }));
    const rerank = yield* call(() =>
      Rerank.create(ctx as unknown as SessionContext, {
        nSeqMax,
        nCtx,
        instruction: opts?.instruction,
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
