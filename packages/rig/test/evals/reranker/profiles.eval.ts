/**
 * CALIBRATION: does an instruction separate the distinctions it claims to?
 *
 *   npx tsx packages/rig/test/evals/reranker/profiles.eval.ts
 *
 * Output is numbers a human reads and freezes into a `RerankTask`. There is no
 * pass/fail, because the question — "is this profile good enough to ship" — is
 * a judgement about margins against the noise floor from `isolation.eval.ts`.
 *
 * TWO THINGS THIS MEASURES, and conflating them was the original error:
 *
 *   WITHIN a passage — does the supported candidate outrank the others?
 *     This is what the reranker is for, and it works.
 *   ACROSS passages — is there one threshold separating supported from
 *     unsupported everywhere? It does NOT work, and cannot: the score scale
 *     shifts per query. `Rerank.ts` says so — "a relative ranker, not an
 *     absolute calibrator".
 *
 * So a profile is usable when its WORST WITHIN-GROUP margin comfortably exceeds
 * the noise floor. A global overlap is expected and is not a failure.
 *
 * Recorded 2026-08-18, f16, `factcheck` × passage-as-query:
 *   within-group ordering correct in 4/4 groups (margins 0.135 / 0.707 / 0.542 / 5.940)
 *   global overlap 1.581 — as expected for a relative ranker
 *
 * Direction × wording, worst within-group margin:
 *   compound   × passage-as-query    INVERTED
 *   compound   × assertion-as-query  INVERTED
 *   entailment × passage-as-query    0.061
 *   entailment × assertion-as-query  0.137
 *   factcheck  × passage-as-query    0.133
 *   factcheck  × assertion-as-query  0.963   ← best discrimination, worst batching
 */

import { call, run } from 'effection';
import { createReranker } from '../../../src/node';
import {
  DISCRIMINATING, IDENTITY_CASES, INSTRUCTIONS, SUPPORT_CASES,
  orient, probeInstruction, rerankerModelPath,
  type CaseGroup, type Direction,
} from './fixtures';

type Reranker = { scoreBatch(q: string, texts: string[]): Promise<number[]> };

/** Score each group as one batch — one passage as query, candidates as documents. */
function* table(modelPath: string, id: string, instruction: string, groups: CaseGroup[]) {
  const r = (yield* createReranker(modelPath, { instruction: probeInstruction(instruction) })) as unknown as Reranker;
  console.log(`\n${'='.repeat(72)}\n${id}\n${'='.repeat(72)}`);

  const sup: number[] = [];
  const uns: number[] = [];
  for (const g of groups) {
    const scores = (yield* call(() => r.scoreBatch(g.passage, g.candidates.map((c) => c.text)))) as number[];
    console.log(`\n  ${g.label}`);
    const gs: number[] = [];
    const gu: number[] = [];
    g.candidates.forEach((c, i) => {
      console.log(`    ${scores[i].toFixed(3).padStart(8)}  ${c.expected.padEnd(11)} ${c.note}`);
      if (c.expected === 'supported') { sup.push(scores[i]); gs.push(scores[i]); }
      if (c.expected === 'unsupported') { uns.push(scores[i]); gu.push(scores[i]); }
    });
    if (gs.length && gu.length) {
      const m = Math.min(...gs) - Math.max(...gu);
      console.log(`    within-group margin ${m >= 0 ? '+' : ''}${m.toFixed(3)}${m > 0 ? '' : '   <-- INVERTED'}`);
    }
  }
  if (sup.length && uns.length) {
    const global = Math.min(...sup) - Math.max(...uns);
    console.log(
      `\n  global separation ${global.toFixed(3)} ` +
        `(${global > 0 ? 'separates' : 'OVERLAPS — expected; use within-group ranking, not a threshold'})`,
    );
  }
}

/** The direction × wording matrix, on the hardest pairs only. */
function* matrix(modelPath: string) {
  console.log(`\n${'='.repeat(72)}\ndirection x wording — worst within-group margin\n${'='.repeat(72)}`);
  for (const [name, instruction] of Object.entries(INSTRUCTIONS)) {
    if (name === 'identity') continue;
    for (const d of ['passage-as-query', 'assertion-as-query'] as Direction[]) {
      const r = (yield* createReranker(modelPath, { instruction: probeInstruction(instruction) })) as unknown as Reranker;
      const scored: { supported: boolean; group: number; score: number; note: string }[] = [];
      for (const c of DISCRIMINATING) {
        const [q, doc] = orient(d, c.passage, c.assertion);
        const s = (yield* call(() => r.scoreBatch(q, [doc]))) as number[];
        scored.push({ supported: c.supported, group: c.group, score: s[0], note: c.note });
      }
      const margins: number[] = [];
      for (const g of new Set(scored.map((x) => x.group))) {
        const inG = scored.filter((x) => x.group === g);
        const s = inG.filter((x) => x.supported).map((x) => x.score);
        const u = inG.filter((x) => !x.supported).map((x) => x.score);
        if (s.length && u.length) margins.push(Math.min(...s) - Math.max(...u));
      }
      const worst = Math.min(...margins);
      console.log(`  ${name.padEnd(11)} ${d.padEnd(18)} ${worst >= 0 ? worst.toFixed(3).padStart(7) : ' INVERTED'}`);
    }
  }
}

run(function* () {
  const modelPath = yield* call(() => rerankerModelPath());
  yield* table(modelPath, 'citation-support/probe', INSTRUCTIONS.factcheck, SUPPORT_CASES);
  yield* table(modelPath, 'event-identity/probe', INSTRUCTIONS.identity, IDENTITY_CASES);
  yield* matrix(modelPath);
  console.log(
    `\n${'='.repeat(72)}\nA profile ships when its worst WITHIN-GROUP margin clears the noise\n` +
      `floor from isolation.eval.ts by a comfortable multiple. Global overlap is\n` +
      `expected and is not a failure.\n`,
  );
}).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
