/**
 * CALIBRATION: does an instruction separate the distinctions it claims to?
 *
 *   npx tsx packages/rig/test/evals/reranker/profiles.eval.ts
 *
 * Output is numbers a human reads and freezes into a `RerankInstruction`. There is no
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
 * The two directions need DIFFERENT fixture shapes, and conflating them is the
 * easy mistake — an earlier version of this file scored each (passage,
 * assertion) pair separately in assertion-as-query mode, which put a different
 * assertion in query position per row and then compared the scores. Those
 * margins were not comparable and the numbers they produced were discarded.
 *
 *   passage-as-query   — one passage, many candidate assertions, one batch
 *   assertion-as-query — one assertion, many candidate passages, one batch
 *
 * Both now score within a single query, so both margins are real. They are NOT
 * comparable to each other, and the bigger number is not the better direction:
 *
 *   compound    passage-as-query  INVERTED   assertion-as-query  1.809
 *   entailment  passage-as-query    0.059    assertion-as-query  2.370
 *   factcheck   passage-as-query    0.135    assertion-as-query  2.844
 *
 * assertion-as-query is discriminating topically-distinct PASSAGES — close to
 * retrieval, which these weights are trained for, so the margins are wide and
 * the question is easy. passage-as-query is discriminating near-identical
 * ASSERTIONS against one passage — wrong-actor against verbatim — which is the
 * actual support judgement and is hard. Read the left column when asking
 * whether a support instruction works.
 *
 * The finding that matters: compound instructions ("date AND actor AND
 * modality") INVERT on the hard question, and `factcheck` is the best wording
 * there at 0.135 — 34x the f16 noise floor, but thin.
 */

import { call, run, scoped } from 'effection';
import type { Operation } from 'effection';
import { createReranker } from '../../../src/node';
import {
  ALL_PASSAGES, ASSERTION_AS_QUERY, DISCRIMINATING, IDENTITY_CASES,
  INSTRUCTIONS, SUPPORT_CASES, probeInstruction, rerankerModelPath,
  type CaseGroup,
} from './fixtures';

type Reranker = { scoreBatch(q: string, texts: string[]): Promise<number[]> };

/** Score each group as one batch — one passage as query, candidates as documents. */
function* table(modelPath: string, id: string, instruction: string, groups: CaseGroup[]): Operation<void> {
  console.log(`\n${'='.repeat(72)}\n${id}\n${'='.repeat(72)}`);
  yield* scoped(function* (): Operation<void> {
  const r = (yield* createReranker(modelPath, { instruction: probeInstruction(instruction) })) as unknown as Reranker;

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
  });
}

/** Worst within-group margin under `passage-as-query` — one passage, many assertions. */
function* passageAsQuery(modelPath: string, instruction: string): Operation<number> {
  // scoped(): createReranker is a resource whose context lives until its scope
  // exits. Without this every instruction's context (448 MiB of f16 KV, plus
  // its share of the weights) is retained until the whole eval finishes.
  return (yield* scoped(function* () {
    const r = (yield* createReranker(modelPath, { instruction: probeInstruction(instruction) })) as unknown as Reranker;
    const margins: number[] = [];
    for (const g of new Set(DISCRIMINATING.map((x) => x.group))) {
      const rows = DISCRIMINATING.filter((x) => x.group === g);
      // ONE call: same passage as query, every candidate in the same batch.
      const scores = (yield* call(() => r.scoreBatch(rows[0].passage, rows.map((x) => x.assertion)))) as number[];
      const sup = rows.map((x, i) => ({ ...x, s: scores[i] })).filter((x) => x.supported).map((x) => x.s);
      const uns = rows.map((x, i) => ({ ...x, s: scores[i] })).filter((x) => !x.supported).map((x) => x.s);
      if (sup.length && uns.length) margins.push(Math.min(...sup) - Math.max(...uns));
    }
    return Math.min(...margins);
  })) as number;
}

/** Worst margin under `assertion-as-query` — one assertion, many passages. */
function* assertionAsQuery(modelPath: string, instruction: string): Operation<number> {
  return (yield* scoped(function* () {
    const r = (yield* createReranker(modelPath, { instruction: probeInstruction(instruction) })) as unknown as Reranker;
    const margins: number[] = [];
    for (const c of ASSERTION_AS_QUERY) {
      // ONE call: the assertion as query, its true passage among competitors.
      const scores = (yield* call(() => r.scoreBatch(c.assertion, ALL_PASSAGES))) as number[];
      const trueIdx = ALL_PASSAGES.indexOf(c.truePassage);
      const others = scores.filter((_, i) => i !== trueIdx);
      margins.push(scores[trueIdx] - Math.max(...others));
    }
    return Math.min(...margins);
  })) as number;
}

function* matrix(modelPath: string): Operation<void> {
  console.log(`\n${'='.repeat(72)}\ndirection x wording — worst margin, each within ONE query\n${'='.repeat(72)}`);
  for (const [name, instruction] of Object.entries(INSTRUCTIONS)) {
    if (name === 'identity') continue;
    const p = yield* passageAsQuery(modelPath, instruction);
    const a = yield* assertionAsQuery(modelPath, instruction);
    const fmt = (v: number) => (v >= 0 ? v.toFixed(3).padStart(8) : ' INVERTED');
    console.log(`  ${name.padEnd(11)} passage-as-query ${fmt(p)}   assertion-as-query ${fmt(a)}`);
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
