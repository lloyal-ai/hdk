/**
 * INVARIANT: leaves forked from one parent, given identical tokens, must score
 * identically.
 *
 *   npx tsx packages/rig/test/evals/reranker/isolation.eval.ts [kvType...]
 *
 * This is the only eval here with a pass/fail character — the others produce
 * numbers for a human to read. Each candidate is prefilled into its own leaf
 * with its own `seq_id`, and the attention mask drops every cell not belonging
 * to that sequence, so batching is supposed to be a dispatch optimisation with
 * no semantic effect. Identical inputs, identical outputs.
 *
 * The measured spread IS the noise floor of every score the system produces,
 * and it bounds any margin a profile can rely on. A calibrated threshold below
 * this number is not a threshold.
 *
 * Recorded 2026-08-18 on Qwen3-Reranker-0.6B (nCtx 4096, nSeqMax 10):
 *
 *   q4_0  spread 1.270   ← was the shipped default; EXCEEDS the boot canary's minGap of 1.0
 *   q5_0  spread 0.813   ← worse than q4_0 on the serial path; avoid
 *   q8_0  spread 0.122
 *   f16   spread 0.004   ← current default
 *
 * Not a defect in BranchStore, Rerank, decode_scatter or the logits read — all
 * were verified correct. The cause is KV quantisation alone: each leaf's cells
 * land in different physical blocks and dequantise differently.
 */

import { Branch, BranchStore } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';
import { rerankerModelPath, contextWithKv, type KvType } from './fixtures';

const N_LEAVES = 6;
/** Above this at f16 the isolation property is considered broken, not noisy. */
const F16_TOLERANCE = 0.05;

async function spreadFor(
  ctx: SessionContext,
  store: BranchStore,
  mode: 'scatter' | 'serial',
  parentTokens: number[],
  leafTokens: number[],
  idx: Int32Array,
): Promise<{ scores: number[]; spread: number }> {
  const parent = Branch.create(ctx, 0);
  await parent.prefill(parentTokens);

  const leaves: Branch[] = [];
  for (let i = 0; i < N_LEAVES; i++) leaves.push(await parent.fork({ cloneLogits: false }));

  if (mode === 'scatter') {
    // One decode_scatter for all six — the path Rerank uses for a leaf group.
    await store.prefill(leaves.map((l): [Branch, number[]] => [l, leafTokens]));
  } else {
    // One decode::many each — isolates the scatter path from forking itself.
    for (const l of leaves) await l.prefill(leafTokens);
  }

  const scores = leaves.map((l) => {
    const pair = ctx._branchLogitsAt(l.handle, idx);
    return pair[0] - pair[1];
  });

  for (const l of leaves) await l.pruneSubtree();
  await parent.pruneSubtree();
  return { scores, spread: Math.max(...scores) - Math.min(...scores) };
}

async function main(): Promise<void> {
  const types = (process.argv.slice(2).length ? process.argv.slice(2) : ['f16']) as KvType[];
  const modelPath = await rerankerModelPath();
  let failed = false;

  for (const kv of types) {
    const ctx = await contextWithKv(modelPath, kv);
    const store = new BranchStore(ctx);
    const yes = (await ctx.tokenize('yes', false))[0];
    const no = (await ctx.tokenize('no', false))[0];
    const idx = new Int32Array([yes, no]);

    const parentTokens = await ctx.tokenize(
      'The assessor attended the property on 12 March 2024. The inspection was completed.',
      true,
    );
    const leafTokens = await ctx.tokenize(
      ' Mr Patel attended the property as the assessor. Answer:',
      false,
    );

    const a = await spreadFor(ctx, store, 'scatter', parentTokens, leafTokens, idx);
    const b = await spreadFor(ctx, store, 'serial', parentTokens, leafTokens, idx);

    console.log(`\n${kv}`);
    console.log(`  scatter (store.prefill)  spread ${a.spread.toFixed(6)}`);
    console.log(`  serial  (leaf.prefill)   spread ${b.spread.toFixed(6)}`);
    console.log(`  cross-path Δ on leaf 0   ${Math.abs(a.scores[0] - b.scores[0]).toFixed(6)}`);

    if (kv === 'f16') {
      const worst = Math.max(a.spread, b.spread);
      if (worst > F16_TOLERANCE) {
        console.log(`  FAIL — f16 spread ${worst.toFixed(6)} exceeds ${F16_TOLERANCE}; leaves are not isolated`);
        failed = true;
      } else {
        console.log(`  ok — within ${F16_TOLERANCE}`);
      }
    }
    ctx.dispose();
  }

  if (failed) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
