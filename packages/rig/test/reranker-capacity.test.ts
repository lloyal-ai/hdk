/**
 * The default passage size fits the smallest reranker sizing rig ships.
 *
 * `DEFAULT_CHUNK_TOKENS` is a retrieval granularity choice, not a capacity
 * contract: the reranker's per-leaf budget depends on the instruction and the
 * chat template, which only a loaded `Rerank` knows. This test therefore
 * asks the loaded reranker one question through its existing truncation
 * callback — does a passage of the default size, under a query of the
 * reserve we assume, score whole at nSeqMax 10 / nCtx 4096? — and, separately,
 * proves the callback path is live with a passage no leaf could hold. No
 * assertion names a boundary.
 *
 * Runs only when a Qwen3 reranker GGUF is present (same discovery as the SDK's
 * integration suite): `LLAMA_RERANK_MODEL`, then the cache and sibling paths.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { createContext } from '@lloyal-labs/lloyal.node';
import { Rerank } from '@lloyal-labs/sdk';
import type { RerankTruncation, SessionContext } from '@lloyal-labs/sdk';
import { DEFAULT_CHUNK_TOKENS } from '../src/resources/fit';
import { RERANK_MODEL_PATH } from './helpers/rerank-model';

const MODEL_PATH = RERANK_MODEL_PATH;

/** The smallest sizing `createReranker` ships when a host says nothing. */
const N_SEQ_MAX = 10;
const N_CTX = 4096;
/** The query allowance the default chunk size is stated against. */
const QUERY_TOKENS = 64;

/** A text that tokenizes to exactly `n` tokens: one repeated word is monotone
 *  in its count, so the search converges in a few steps. */
async function textOfTokens(rerank: Rerank, n: number): Promise<string> {
  let words = n;
  for (let i = 0; i < 40; i++) {
    const text = Array.from({ length: words }, () => 'alpha').join(' ');
    const len = (await rerank.tokenize(text)).length;
    if (len === n) return text;
    words += n - len;
  }
  throw new Error(`textOfTokens: could not build a ${n}-token text`);
}

async function drain<T>(iter: AsyncIterable<T>): Promise<void> {
  for await (const _ of iter) { /* consume */ }
}

const describeWithModel = MODEL_PATH ? describe : describe.skip;

describeWithModel(`DEFAULT_CHUNK_TOKENS fits the shipped reranker sizing — ${MODEL_PATH ? path.basename(MODEL_PATH) : 'no model'}`, () => {
  it(
    'a default-size passage under the query reserve scores whole; a passage no leaf could hold is truncated',
    async () => {
      const truncations: RerankTruncation[] = [];
      const ctx = (await createContext({
        modelPath: MODEL_PATH!,
        nCtx: N_CTX,
        nSeqMax: N_SEQ_MAX,
        typeK: 'q4_0',
        typeV: 'q4_0',
      })) as unknown as SessionContext;
      const rerank = await Rerank.create(ctx, {
        nSeqMax: N_SEQ_MAX,
        nCtx: N_CTX,
        onTruncate: (e) => truncations.push(e),
      });
      try {
        const query = await textOfTokens(rerank, QUERY_TOKENS);
        const filler = await rerank.tokenize('word '.repeat(2 * Math.floor(N_CTX / N_SEQ_MAX) + 16));

        // Granularity fits: the default passage is scored whole.
        await drain(rerank.score(query, [filler.slice(0, DEFAULT_CHUNK_TOKENS)], 1));
        expect(truncations).toEqual([]);

        // The callback path is live: twice the per-sequence slice cannot fit any leaf.
        const oversize = filler.slice(0, 2 * Math.floor(N_CTX / N_SEQ_MAX));
        await drain(rerank.score(query, [oversize], 1));
        expect(truncations).toHaveLength(1);
        expect(truncations[0]).toMatchObject({ docIndex: 0, origLen: oversize.length });
        expect(truncations[0].maxLen).toBeGreaterThanOrEqual(DEFAULT_CHUNK_TOKENS);
      } finally {
        rerank.dispose();
      }
    },
    120_000,
  );
});
