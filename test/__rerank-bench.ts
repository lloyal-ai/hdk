/**
 * R-Final — BM25 first-stage wall-time benchmark.
 *
 * Builds a synthetic 500-chunk corpus, then times two scenarios:
 *   A. Reranker only — score all 500 chunks via the cross-encoder.
 *   B. BM25 → Reranker — score all 500 via BM25, take top-50, rerank.
 *
 * Reports wall-time, ratio, and the top-1 chunk index in both runs to confirm
 * the winners survive the first-stage filter.
 *
 * Usage:
 *   LLAMA_RERANK_MODEL=~/.cache/lloyal/models/qwen3-reranker-0.6b-q8_0.gguf \
 *     npx tsx test/__rerank-bench.ts
 *
 * Run without the env var → auto-detects from the same paths as the
 * integration test suite.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createContext } from '@lloyal-labs/lloyal.node';
import { Rerank } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';
import { BM25Index } from '@lloyal-labs/corpus-app';

function resolveRerankerModel(): string {
  const candidates = [
    process.env.LLAMA_RERANK_MODEL,
    path.join(os.homedir(), '.cache/lloyal/models/qwen3-reranker-0.6b-q8_0.gguf'),
    path.join(os.homedir(), '.cache/lloyal/models/qwen3-reranker-0.6b-q4_k_m.gguf'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error('No reranker model found; set LLAMA_RERANK_MODEL');
}

// ── Synthetic corpus ───────────────────────────────────────────────
// 500 short chunks. The 50 "relevant" chunks mention the query keyword
// (Paris) so BM25 should pick them up; the rest are unrelated trivia.

const QUERY = 'What is the capital of France?';

const RELEVANT_TEMPLATES = [
  'Paris is the capital and most populous city of France, located on the river Seine.',
  'The capital of France, Paris, is famous for the Eiffel Tower and the Louvre.',
  'France has its administrative center in Paris, which hosts the National Assembly.',
  'Paris, the French capital, was founded in the 3rd century BC.',
  'The Île-de-France region surrounds Paris, the capital of France.',
];

const DISTRACTOR_TEMPLATES = [
  'The Amazon rainforest produces about 20% of the world\'s oxygen.',
  'Berlin is the capital of Germany and its largest city.',
  'The Great Wall of China is over 13,000 miles long.',
  'Tokyo is the most populous metropolitan area in the world.',
  'The Sahara Desert is the largest hot desert in the world.',
  'Mount Everest is the highest mountain above sea level.',
  'The Pacific Ocean is the largest and deepest ocean on Earth.',
  'Antarctica is the coldest continent.',
  'The Nile is traditionally considered the longest river.',
  'The human body contains approximately 206 bones.',
  'Jupiter is the largest planet in our solar system.',
  'DNA was first identified by Friedrich Miescher in 1869.',
  'The International Space Station orbits Earth every 90 minutes.',
  'Honey never spoils due to its low moisture content.',
  'Venice is built on more than 100 small islands.',
  'The deepest point in the ocean is the Mariana Trench.',
  'Photosynthesis converts carbon dioxide and water into glucose.',
  'The speed of light is approximately 299,792 kilometers per second.',
  'Australia is both a country and a continent.',
];

function buildCorpus(N = 500, relevantFraction = 0.1): string[] {
  const chunks: string[] = [];
  const numRelevant = Math.floor(N * relevantFraction);
  for (let i = 0; i < numRelevant; i++) {
    const t = RELEVANT_TEMPLATES[i % RELEVANT_TEMPLATES.length];
    chunks.push(`Chunk ${i} (relevant): ${t}`);
  }
  for (let i = numRelevant; i < N; i++) {
    const t = DISTRACTOR_TEMPLATES[(i - numRelevant) % DISTRACTOR_TEMPLATES.length];
    chunks.push(`Chunk ${i}: ${t}`);
  }
  // Shuffle deterministically so the relevant chunks aren't at the top.
  let seed = 1729;
  for (let i = chunks.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [chunks[i], chunks[j]] = [chunks[j], chunks[i]];
  }
  return chunks;
}

async function drain<T>(iter: AsyncIterable<T>): Promise<T> {
  let last: T | undefined;
  for await (const v of iter) last = v;
  return last as T;
}

async function main() {
  const modelPath = resolveRerankerModel();
  console.log(`Reranker model: ${path.basename(modelPath)}`);

  const docs = buildCorpus(500, 0.1);
  console.log(`Corpus size: ${docs.length} chunks (50 lexically relevant)\n`);

  const ctx = (await createContext({
    modelPath,
    nCtx: 4096,
    nSeqMax: 10,
    typeK: 'q4_0',
    typeV: 'q4_0',
  })) as unknown as SessionContext;
  const rerank = await Rerank.create(ctx);

  // Tokenize once.
  console.log('Tokenizing corpus...');
  const t0 = performance.now();
  const docTokens = await Promise.all(docs.map((d) => rerank.tokenize(d)));
  const tokenizeMs = performance.now() - t0;
  console.log(`Tokenized ${docs.length} chunks in ${tokenizeMs.toFixed(0)}ms\n`);

  // Build BM25 index.
  const tIndex = performance.now();
  const bm25 = new BM25Index(docTokens);
  const indexMs = performance.now() - tIndex;
  console.log(`Built BM25 index in ${indexMs.toFixed(1)}ms`);

  // ── Scenario A — Reranker only ──────────────────────────────
  console.log('\nScenario A: cross-encoder reranker over ALL chunks');
  const a0 = performance.now();
  const fullResult = await drain(rerank.score(QUERY, docTokens));
  const aMs = performance.now() - a0;
  console.log(`  wall-time: ${aMs.toFixed(0)}ms`);
  console.log(`  top-1 chunk index: ${fullResult.results[0].index} (score ${fullResult.results[0].score.toFixed(3)})`);

  // ── Scenario B — BM25 first-stage → reranker ────────────────
  const FIRST_STAGE_K = 100;
  console.log(`\nScenario B: BM25 → top-${FIRST_STAGE_K} → cross-encoder`);
  const b0 = performance.now();
  const queryTokens = await rerank.tokenize(QUERY);
  const bm25Hits = bm25.score(queryTokens, FIRST_STAGE_K);
  const bm25Ms = performance.now() - b0;
  const candidateTokens = bm25Hits.map((h) => docTokens[h.index]);
  const rerank0 = performance.now();
  const reducedResult = await drain(rerank.score(QUERY, candidateTokens));
  const rerankMs = performance.now() - rerank0;
  const bMs = performance.now() - b0;

  // Map reduced result back to original corpus indices for verification.
  const top1OriginalIdx = bm25Hits[reducedResult.results[0].index].index;
  console.log(`  wall-time: ${bMs.toFixed(0)}ms (BM25 ${bm25Ms.toFixed(1)}ms + tokenize+rerank ${rerankMs.toFixed(0)}ms)`);
  console.log(`  top-1 chunk index: ${top1OriginalIdx} (score ${reducedResult.results[0].score.toFixed(3)})`);

  // ── Summary ─────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log(`Wall-time ratio (A / B): ${(aMs / bMs).toFixed(2)}×`);
  console.log(`Top-1 winner survived BM25 filter: ${top1OriginalIdx === fullResult.results[0].index ? 'YES' : 'NO'}`);
  console.log(`Top-3 overlap between scenarios:`);
  const aTop3 = new Set(fullResult.results.slice(0, 3).map((r) => r.index));
  const bTop3 = new Set(reducedResult.results.slice(0, 3).map((r) => bm25Hits[r.index].index));
  let overlap = 0;
  for (const i of aTop3) if (bTop3.has(i)) overlap++;
  console.log(`  ${overlap}/3 chunks in common`);
  console.log('='.repeat(60));

  rerank.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
