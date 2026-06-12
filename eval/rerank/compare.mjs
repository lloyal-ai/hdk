#!/usr/bin/env node
/**
 * Rerank eval pack — tiered comparator. Diffs two scores.json files under
 * the standing bump-gate tiers:
 *
 *   Tier 1 (PRIMARY, pass/fail): rank-order stability — Kendall-τ over the
 *     full candidate ranking + top-5/top-10 overlap per query. Retrieval
 *     consumers see ORDER; this is the behavior gate.
 *   Tier 2 (calibrated): per-pair |Δscore| distribution (median/p95/max).
 *     Thresholds come from a same-build replay (noise floor), never from
 *     intuition. Report-only until a floor file exists.
 *   Tier 3 (informational): exact-equality count. Cross-build byte equality
 *     is NOT expected (BLAS batch-splits etc.); never gate on it.
 *
 * Usage: node compare.mjs A.json B.json [--floor noise-floor.json] [--tau-min 0.95] [--top5-min 4]
 */
import { readFileSync } from 'node:fs';

const [fileA, fileB] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const TAU_MIN = Number(args['tau-min'] ?? 0.95);
const TOP5_MIN = Number(args['top5-min'] ?? 4);

const A = JSON.parse(readFileSync(fileA, 'utf8'));
const B = JSON.parse(readFileSync(fileB, 'utf8'));
if (A.meta.fixturesDocsSha !== B.meta.fixturesDocsSha) {
  console.error('FATAL: runs used different fixture revisions — comparison is meaningless.');
  process.exit(2);
}

function kendallTau(rankA, rankB) {
  const posB = new Map(rankB.map((x, i) => [x, i]));
  const seq = rankA.map((x) => posB.get(x));
  let concordant = 0, discordant = 0;
  for (let i = 0; i < seq.length; i++) {
    for (let j = i + 1; j < seq.length; j++) {
      if (seq[i] < seq[j]) concordant++; else discordant++;
    }
  }
  const n = seq.length;
  return (concordant - discordant) / (n * (n - 1) / 2);
}

function overlap(a, b, k) {
  const sa = new Set(a.slice(0, k));
  return b.slice(0, k).filter((x) => sa.has(x)).length;
}

function quantile(sorted, q) {
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

console.log(`A: ${fileA}  (${A.meta.sdk.split('/').slice(-4).join('/')}, nSeqMax=${A.meta.nSeqMax})`);
console.log(`B: ${fileB}  (${B.meta.sdk.split('/').slice(-4).join('/')}, nSeqMax=${B.meta.nSeqMax})`);
console.log();

const rows = [];
const allDeltas = [];
let exactEqual = 0, totalPairs = 0;
for (const ra of A.results) {
  const rb = B.results.find((r) => r.id === ra.id);
  if (!rb) continue;
  const tau = kendallTau(ra.ranking, rb.ranking);
  const o5 = overlap(ra.ranking, rb.ranking, 5);
  const o10 = overlap(ra.ranking, rb.ranking, 10);
  const deltas = Object.keys(ra.scores)
    .map((k) => Math.abs(ra.scores[k] - rb.scores[k]))
    .sort((x, y) => x - y);
  for (const k of Object.keys(ra.scores)) {
    totalPairs++;
    if (ra.scores[k] === rb.scores[k]) exactEqual++;
  }
  allDeltas.push(...deltas);
  rows.push({ id: ra.id, kind: ra.kind, tau, o5, o10,
    dMed: quantile(deltas, 0.5), dP95: quantile(deltas, 0.95), dMax: deltas.at(-1),
    topSameA: ra.ranking[0] === rb.ranking[0] });
}

console.log('id    kind     τ       top5  top10  |Δ|med   |Δ|p95   |Δ|max   top1-same');
for (const r of rows) {
  console.log(
    `${r.id}  ${r.kind.padEnd(8)} ${r.tau.toFixed(3).padStart(6)}  ${r.o5}/5   ` +
    `${String(r.o10).padStart(2)}/10  ${r.dMed.toFixed(4)}  ${r.dP95.toFixed(4)}  ` +
    `${r.dMax.toFixed(4)}   ${r.topSameA ? 'yes' : 'NO'}`,
  );
}

allDeltas.sort((x, y) => x - y);
const summary = {
  queries: rows.length,
  tauMin: Math.min(...rows.map((r) => r.tau)),
  tauMean: rows.reduce((s, r) => s + r.tau, 0) / rows.length,
  top5Min: Math.min(...rows.map((r) => r.o5)),
  top1Changed: rows.filter((r) => !r.topSameA).map((r) => r.id),
  deltaMedian: quantile(allDeltas, 0.5),
  deltaP95: quantile(allDeltas, 0.95),
  deltaMax: allDeltas.at(-1),
  exactEqualPct: Math.round((exactEqual / totalPairs) * 100),
};
console.log('\nSUMMARY', JSON.stringify(summary, null, 1));

// Tier 1 gate
const tier1Pass = summary.tauMin >= TAU_MIN && summary.top5Min >= TOP5_MIN;
console.log(`\nTIER 1 (rank order, τ≥${TAU_MIN} & top5≥${TOP5_MIN}/5): ${tier1Pass ? 'PASS' : 'FAIL'}`);

// Tier 2 vs noise floor, if provided
if (args.floor) {
  const floor = JSON.parse(readFileSync(args.floor, 'utf8'));
  const limit = Math.max(floor.deltaP95 * 5, 0.05);
  const tier2Pass = summary.deltaP95 <= limit;
  console.log(`TIER 2 (|Δ|p95 ${summary.deltaP95.toFixed(4)} ≤ 5×floor ${limit.toFixed(4)}): ${tier2Pass ? 'PASS' : 'FAIL'}`);
  process.exitCode = tier1Pass && tier2Pass ? 0 : 1;
} else {
  console.log('TIER 2: no --floor provided — report-only. Run a same-build replay and pass it as --floor.');
  process.exitCode = tier1Pass ? 0 : 1;
}
console.log(`TIER 3 (informational): ${summary.exactEqualPct}% byte-identical scores`);
