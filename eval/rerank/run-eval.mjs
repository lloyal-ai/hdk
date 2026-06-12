#!/usr/bin/env node
/**
 * Rerank eval pack — scorer. Runs the FROZEN fixtures through one build of
 * the scoring stack and emits scores.json. Build-agnostic by design: point
 * `--sdk` / `--node` at any dist (the uncommitted working tree, a PRE git
 * worktree, a future llama.cpp bump) and the same fixtures score through it.
 *
 * Both PRE (committed) and POST Rerank expose the same surface used here:
 *   Rerank.create(ctx, { nSeqMax, nCtx })  +  scoreBatch(query, texts)
 *
 * Usage:
 *   node run-eval.mjs --out scores-post.json [--nseq 10] \
 *     [--sdk ../../dist/index.js] [--node @lloyal-labs/lloyal.node] \
 *     [--fixtures fixtures.json] [--model ~/.cache/.../qwen3-reranker-0.6b-q8_0.gguf]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);

const FIXTURES = resolve(__dirname, args.fixtures ?? 'fixtures.json');
const OUT = resolve(__dirname, args.out ?? 'scores.json');
const NSEQ = Number(args.nseq ?? 10);
const NCTX = Number(args.nctx ?? 16384);
const MODEL = resolve(
  args.model ?? `${homedir()}/.cache/lloyal/models/qwen3-reranker-0.6b-q8_0.gguf`,
);
const SDK = args.sdk ? pathToFileURL(resolve(args.sdk)).href : '../../packages/sdk/dist/index.js';
const NODE = args.node
  ? pathToFileURL(resolve(args.node)).href
  : '@lloyal-labs/lloyal.node';

const { createContext } = await import(NODE);
const { Rerank } = await import(SDK);

const fx = JSON.parse(readFileSync(FIXTURES, 'utf8'));
console.log(
  `fixtures: ${fx.queries.length} queries (docs ${fx.meta.docsSha.slice(0, 12)})` +
  `  model: ${MODEL.split('/').pop()}  nSeqMax=${NSEQ} nCtx=${NCTX}`,
);
console.log(`sdk: ${SDK}\nnode: ${NODE}`);

const ctx = await createContext({ modelPath: MODEL, nCtx: NCTX, nSeqMax: NSEQ });
const t0 = performance.now();
let rerank;
const results = [];
try {
  rerank = await Rerank.create(ctx, { nSeqMax: NSEQ, nCtx: NCTX });
  for (const q of fx.queries) {
    const texts = q.candidates.map((c) => c.text);
    const qt = performance.now();
    const scores = await rerank.scoreBatch(q.text, texts);
    const ms = performance.now() - qt;
    const ranking = scores
      .map((s, i) => ({ chunkIndex: q.candidates[i].chunkIndex, score: s }))
      .sort((a, b) => b.score - a.score);
    results.push({
      id: q.id, kind: q.kind, text: q.text, ms: Math.round(ms),
      scores: Object.fromEntries(
        q.candidates.map((c, i) => [c.chunkIndex, scores[i]]),
      ),
      ranking: ranking.map((r) => r.chunkIndex),
      top3: ranking.slice(0, 3).map((r) => ({
        chunkIndex: r.chunkIndex,
        score: Number(r.score.toFixed(4)),
        file: q.candidates.find((c) => c.chunkIndex === r.chunkIndex)?.file,
      })),
    });
    console.log(
      `  ${q.id} [${q.kind}] top=${ranking[0].score.toFixed(2).padStart(7)} ` +
      `${String(Math.round(ms)).padStart(6)}ms  "${q.text.slice(0, 44)}"`,
    );
  }
} finally {
  await rerank?.dispose?.();
  await ctx.dispose?.();
}

writeFileSync(OUT, JSON.stringify({
  meta: {
    fixturesDocsSha: fx.meta.docsSha, model: MODEL.split('/').pop(),
    nSeqMax: NSEQ, nCtx: NCTX,
    // provenance recorded path-free: artifacts land in a public repo
    sdk: args.sdk ? 'override:' + SDK.split('/').slice(-5, -1).join('/') : 'working-tree',
    node: args.node ? 'override:' + NODE.split('/').slice(-6, -2).join('/') : 'working-tree', totalMs: Math.round(performance.now() - t0),
    ranAt: new Date().toISOString(),
  },
  results,
}, null, 1));
console.log(`wrote ${OUT}  (total ${Math.round((performance.now() - t0) / 1000)}s)`);
