/**
 * The reranker's resolution under the KV type `createReranker` ships by
 * default: ten identical passages in one call fill the ten leaves, so any
 * spread between their scores is KV noise, not content. Measured 2026-09-07
 * on real document windows: at q4_0 the spread was 4–6 logits and the verdict
 * changed sign between leaves; at q8_0 it was 0.05–0.12 at the same speed.
 * Every admission threshold stands on this number.
 *
 * Weights-gated like `reranker-capacity.test.ts`.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import { run, call } from 'effection';
import * as path from 'node:path';
import { createReranker } from '../src/reranker';
import { RERANK_MODEL_PATH } from './helpers/rerank-model';

const describeWithModel = RERANK_MODEL_PATH ? describe : describe.skip;

const QUERY = 'What is the capital of France?';
const RELEVANT = 'Paris is the capital and largest city of France, on the river Seine.';
const IRRELEVANT = 'The recipe calls for two eggs, a cup of flour and a pinch of salt.';
const COPIES = 10;
/** The widest spread the default KV type may show between identical leaves. */
const MAX_SPREAD = 0.5;

describeWithModel(`the default KV type resolves the reranker's verdicts — ${RERANK_MODEL_PATH ? path.basename(RERANK_MODEL_PATH) : 'no model'}`, () => {
  it('ten identical passages score within half a logit of each other, and the relevant passage stays above the irrelevant one', async () => {
    const scores: number[] = await run(function* () {
      const reranker = yield* createReranker(RERANK_MODEL_PATH!, { nSeqMax: COPIES, nCtx: 4096 });
      const texts = [...Array<string>(COPIES).fill(RELEVANT), ...Array<string>(COPIES).fill(IRRELEVANT)];
      return yield* call(() => reranker.scoreBatch(QUERY, texts));
    });
    const relevant = scores.slice(0, COPIES);
    const irrelevant = scores.slice(COPIES);
    const spread = (xs: number[]): number => Math.max(...xs) - Math.min(...xs);
    const show = (xs: number[]): string => xs.map((s) => s.toFixed(2)).join(' ');
    expect(spread(relevant), `relevant copies: ${show(relevant)}`).toBeLessThan(MAX_SPREAD);
    expect(spread(irrelevant), `irrelevant copies: ${show(irrelevant)}`).toBeLessThan(MAX_SPREAD);
    expect(Math.min(...relevant), `relevant ${show(relevant)} vs irrelevant ${show(irrelevant)}`).toBeGreaterThan(Math.max(...irrelevant));
  }, 120_000);
});
