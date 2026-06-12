#!/usr/bin/env node
/**
 * Rerank eval pack — fixture builder. Run ONCE per fixture revision.
 *
 * Freezes (query, candidate-chunk) pairs so any two builds of the scoring
 * stack — across llama.cpp bumps, SDK refactors, quantizations — compare on
 * EXACTLY the same inputs. Input fixity is the point: live traces can never
 * separate "scores moved" from "the candidate set moved" (BM25, corpus
 * edits, batch composition). Frozen fixtures can.
 *
 * Candidate selection mirrors production exactly: chunks and queries are
 * tokenized through the RERANKER MODEL's tokenizer (not whitespace), then
 * Okapi-BM25 top-30 (the production first stage) + 10 seeded-pseudorandom
 * recall probes (chunks BM25 did NOT pick).
 *
 * Usage: node build-fixtures.mjs [--docs /path/to/hdk-docs] [--out fixtures.json]
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadResources, chunkResources } from '@lloyal-labs/rig/node';
import { createContext } from '@lloyal-labs/lloyal.node';
import { BM25Index } from '../../packages/apps/corpus/dist/bm25.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
// Default assumes the sibling-repo layout (<dev>/lloyal-sdk + <dev>/hdk-docs);
// pass --docs for anything else. Never a hardcoded user path.
const DOCS = resolve(args.docs ?? resolve(__dirname, '../../../hdk-docs'));
const OUT = resolve(__dirname, args.out ?? 'fixtures.json');
const MODEL = resolve(
  args.model ?? `${homedir()}/.cache/lloyal/models/qwen3-reranker-0.6b-q8_0.gguf`,
);

const BM25_TOP = 30;
const RANDOM_EXTRA = 10;
const SEED = 0x5eed;

/**
 * Curated from 74 distinct corpus-scale rerank:start queries across
 * production traces (2026-06-01 → 2026-06-11). Kinds:
 *  - vague:   single/dual bare terms — the model's first probe of a topic
 *  - refined: multi-term compound — the model after iterating
 *  - hard:    known-failure shapes from trace-2026-06-11T07-17 (rank
 *             inversion, homonym collision) — regression sentinels
 *  - absent:  topics the corpus does NOT cover — floor-calibration probes;
 *             a healthy judge scores these low across the board
 */
const QUERIES = [
  { id: 'q01', kind: 'vague', text: 'Electron' },
  { id: 'q02', kind: 'vague', text: '2026' },
  { id: 'q03', kind: 'vague', text: 'orchestration' },
  { id: 'q04', kind: 'vague', text: 'agent framework' },
  { id: 'q05', kind: 'vague', text: 'consumer' },
  { id: 'q06', kind: 'refined', text: 'prefix sharing cells_used accounting' },
  { id: 'q07', kind: 'refined', text: 'ContextPressure partition KV cache hardLimit nBatch' },
  { id: 'q08', kind: 'refined', text: 'KV pressure management consumer applications context budget' },
  { id: 'q09', kind: 'refined', text: 'local-first agent applications single process architecture' },
  { id: 'q10', kind: 'refined', text: 'RIG Retrieval-Interleaved Generation multi-hop reasoning' },
  { id: 'q11', kind: 'refined', text: 'agent pool persistent stateful session' },
  { id: 'q12', kind: 'hard', text: 'rerank architecture four scoring roles' },
  { id: 'q13', kind: 'hard', text: 'lifecycle hooks produce settle recover shouldExit' },
  { id: 'q14', kind: 'absent', text: 'Firefox extension DOM tab query' },
  { id: 'q15', kind: 'absent', text: 'Sourcetable Numerous.ai Rows comparison pricing features' },
  { id: 'q16', kind: 'absent', text: 'Kubernetes ingress TLS certificate rotation' },
];

// Deterministic PRNG (mulberry32) — fixture builds must be reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const docsSha = execSync('git rev-parse HEAD', { cwd: DOCS }).toString().trim();
const dirty = execSync('git status --porcelain', { cwd: DOCS }).toString().trim();
if (dirty) {
  console.warn('WARNING: hdk-docs has uncommitted changes — fixture texts may not be reproducible from the recorded SHA.');
}

const resources = loadResources(DOCS);
const chunks = chunkResources(resources);
console.log(`docs ${docsSha.slice(0, 12)}${dirty ? ' (DIRTY)' : ''} → ${resources.length} resources, ${chunks.length} chunks`);

const ctx = await createContext({ modelPath: MODEL, nCtx: 2048 });
try {
  const docTokens = [];
  for (const c of chunks) docTokens.push(await ctx.tokenize(c.text, false));
  const index = new BM25Index(docTokens);

  const fixtures = [];
  for (const q of QUERIES) {
    const qTokens = await ctx.tokenize(q.text, false);
    const top = index.score(qTokens, BM25_TOP).map((h) => h.index);
    const picked = new Set(top);
    const rand = mulberry32(SEED ^ q.id.charCodeAt(2));
    while (picked.size < Math.min(BM25_TOP + RANDOM_EXTRA, chunks.length)) {
      picked.add(Math.floor(rand() * chunks.length));
    }
    fixtures.push({
      ...q,
      candidates: [...picked].map((i) => ({
        chunkIndex: i,
        bm25: top.includes(i),
        file: chunks[i].resource,
        heading: chunks[i].heading ?? null,
        text: chunks[i].text,
      })),
    });
    console.log(`  ${q.id} [${q.kind}] ${picked.size} candidates  "${q.text.slice(0, 50)}"`);
  }

  writeFileSync(OUT, JSON.stringify({
    meta: {
      docsPath: '../hdk-docs', docsSha, docsDirty: Boolean(dirty),
      chunkCount: chunks.length, bm25Top: BM25_TOP, randomExtra: RANDOM_EXTRA,
      seed: SEED, model: MODEL.split('/').pop(), builtAt: new Date().toISOString(),
    },
    queries: fixtures,
  }, null, 1));
  console.log(`wrote ${OUT}`);
} finally {
  await ctx.dispose?.();
}
