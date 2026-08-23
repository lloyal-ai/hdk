/**
 * Shared cases and harness for the reranker evals.
 *
 * These are NOT unit tests. They load a real ~640 MB model and take minutes, so
 * they are named `.eval.ts` — vitest's include is `packages/*&#47;test&#47;**&#47;*.test.ts`
 * and must never pick them up. They are typechecked via the tsconfig beside
 * them: an eval that silently mis-calls its API measures nothing, which is
 * exactly how an earlier run of these fixtures produced numbers for the wrong
 * instruction.
 */

import { createContext } from '@lloyal-labs/lloyal.node';
import type { SessionContext, RerankInstruction } from '@lloyal-labs/sdk';
import { MODEL_CATALOG, resolveModel } from '../../../src/node';

/** KV cache types worth comparing. `f32`/`bf16`/`q4_1`/`iq4_nl`/`q5_1` also exist. */
export type KvType = 'q4_0' | 'q5_0' | 'q8_0' | 'f16';

/** Resolve the catalog's reranker, downloading + verifying if absent. */
export async function rerankerModelPath(): Promise<string> {
  const entry = MODEL_CATALOG.find((e) => e.role === 'reranker');
  if (!entry) throw new Error('no reranker in MODEL_CATALOG');
  // NOTE: materialises into <projectRoot>/models/ — gitignored for this reason.
  return resolveModel({ projectRoot: process.cwd(), role: 'reranker', spec: { id: entry.id } });
}

/**
 * A context with an explicitly chosen KV type.
 *
 * Deliberately below `createReranker`, which hardcodes f16 — these evals exist
 * to measure what that choice buys, so they cannot go through it.
 */
export async function contextWithKv(
  modelPath: string,
  kv: KvType,
  nCtx = 4096,
  nSeqMax = 10,
): Promise<SessionContext> {
  return (await createContext({
    modelPath,
    nCtx,
    nSeqMax,
    nBatch: Math.floor(nCtx / nSeqMax),
    typeK: kv,
    typeV: kv,
  })) as unknown as SessionContext;
}

/**
 * An instruction wired for measurement.
 *
 * `smokeTest: 'none'` BY DESIGN. A calibration harness exists to observe
 * instructions that FAIL — `compound` inverts — and a gate that rejects
 * inversion would suppress the most useful negative result here.
 */
export function probeInstruction(text: string): RerankInstruction {
  return { text, smokeTest: 'none' };
}

// ── Instruction wordings ─────────────────────────────────────
//
// A cross-encoder follows ONE criterion. `compound` is kept because it is the
// intuitive phrasing and it INVERTS — wrong-actor outscores verbatim — which is
// the single most useful negative result here.
export const INSTRUCTIONS = {
  compound:
    'Given a passage of evidence, judge whether the passage on its own fully ' +
    'supports the stated assertion — including its date, the actor involved, ' +
    'and whether the event occurred or was only scheduled, alleged or denied',
  entailment:
    'Judge whether the statement is entailed by the evidence, and false if it ' +
    'differs in any detail',
  factcheck:
    'Given a claim, determine whether the document confirms the claim is accurate',
  identity:
    'Judge whether the statement describes the same occurrence as the ' +
    'evidence, and false if it differs in timing, actor or outcome',
} as const;

/** Which side of the pair goes in `<Query>`. Changes both accuracy and batching. */
export type Direction = 'passage-as-query' | 'assertion-as-query';

export function orient(d: Direction, passage: string, assertion: string): [string, string] {
  return d === 'passage-as-query' ? [passage, assertion] : [assertion, passage];
}

// ── Cases ────────────────────────────────────────────────────

export type Expected = 'supported' | 'unsupported' | 'either';

export interface CaseGroup {
  label: string;
  /** One passage, several candidate assertions — the production batching shape. */
  passage: string;
  candidates: { text: string; expected: Expected; note: string }[];
}

/**
 * The citation-support canary table.
 *
 * Every row is a distinction the extractor is asked to make, so a profile that
 * separates these is coherent with what the extractor is told to produce.
 */
export const SUPPORT_CASES: CaseGroup[] = [
  {
    label: 'assessor report',
    passage:
      'The assessor attended the property on 12 March 2024. The inspection was ' +
      'completed and no defects were noted. The owner, Mr Patel, was present throughout.',
    candidates: [
      { text: 'The assessor attended the property on 12 March 2024.', expected: 'supported', note: 'stated verbatim' },
      { text: 'An assessment of the property took place on 12 March 2024.', expected: 'supported', note: 'complete support, paraphrased' },
      { text: 'The property was sold in June 2024.', expected: 'unsupported', note: 'same topic, no assertion' },
      { text: 'Mr Patel attended the property on 12 March 2024 as the assessor.', expected: 'unsupported', note: 'right event, wrong actor' },
      { text: 'The assessor attended the property on 14 March 2024.', expected: 'unsupported', note: 'right event, wrong date' },
      { text: 'Defects were noted during the inspection.', expected: 'unsupported', note: 'explicit contradiction' },
    ],
  },
  {
    label: 'notice (scheduled)',
    passage: 'The inspection is scheduled for 18 March 2024. The officer will attend between 9am and noon.',
    candidates: [
      { text: 'The inspection was scheduled for 18 March 2024.', expected: 'supported', note: 'modality preserved' },
      { text: 'The inspection occurred on 18 March 2024.', expected: 'unsupported', note: 'scheduled, not occurred' },
    ],
  },
  {
    label: 'allegation',
    passage: 'The claimant alleges that payment was made on 3 April 2024. No receipt has been produced.',
    candidates: [
      { text: 'The claimant alleges payment was made on 3 April 2024.', expected: 'supported', note: 'attribution preserved' },
      { text: 'Payment was made on 3 April 2024.', expected: 'unsupported', note: 'allegation presented as fact' },
    ],
  },
  {
    label: 'negation',
    passage: 'No follow-up appointment occurred in April 2024.',
    candidates: [
      { text: 'No follow-up appointment occurred in April 2024.', expected: 'supported', note: 'negation preserved' },
      { text: 'A follow-up appointment occurred in April 2024.', expected: 'unsupported', note: 'negated event asserted' },
    ],
  },
  {
    label: 'needs adjacent context',
    passage: 'He returned three days later and signed the form.',
    candidates: [
      { text: 'He returned on 15 March 2024 and signed the form.', expected: 'unsupported', note: 'span not independently sufficient' },
      { text: 'He signed the form.', expected: 'either', note: 'half of a compound assertion' },
    ],
  },
];

/** Event identity — reconciliation's question. Topical similarity is NOT identity. */
export const IDENTITY_CASES: CaseGroup[] = [
  {
    label: 'same event, different wording',
    passage: 'The inspection took place at the property.',
    candidates: [
      { text: 'The assessor attended and inspected the property.', expected: 'supported', note: 'same event' },
      { text: 'The appeal was lodged with the tribunal.', expected: 'unsupported', note: 'different event' },
    ],
  },
  {
    label: 'near miss — the chaining trap',
    passage: 'The letter was sent to the claimant.',
    candidates: [
      { text: 'The letter was received by the claimant.', expected: 'unsupported', note: 'related but a DIFFERENT event' },
      { text: 'The letter was destroyed.', expected: 'unsupported', note: 'different event, shares the subject' },
    ],
  },
  {
    label: 'modality pair — must NOT be one event',
    passage: 'The inspection was scheduled for 18 March.',
    candidates: [
      { text: 'The inspection occurred on 18 March.', expected: 'unsupported', note: 'scheduled is not occurred' },
    ],
  },
];

/**
 * ONE assertion as `<Query>`, its true passage against competing passages as
 * `<Document>`s — a single batch, so every score shares a query and the margin
 * is real.
 *
 * This exists because the obvious construction is WRONG. Scoring each
 * (passage, assertion) pair separately and comparing across them puts a
 * DIFFERENT assertion in query position per row, and the scale shifts per
 * query — which is the finding this whole suite establishes. Margins built that
 * way are not comparable, however sensible the table looks.
 */
export const ASSERTION_AS_QUERY: { assertion: string; truePassage: string; note: string }[] = [
  { assertion: 'The assessor attended the property on 12 March 2024.', truePassage: SUPPORT_CASES[0].passage, note: 'verbatim vs other passages' },
  { assertion: 'The inspection was scheduled for 18 March 2024.', truePassage: SUPPORT_CASES[1].passage, note: 'scheduled vs other passages' },
  { assertion: 'The claimant alleges payment was made on 3 April 2024.', truePassage: SUPPORT_CASES[2].passage, note: 'allegation vs other passages' },
];

/** Every passage, so a true one can be scored against genuine competitors. */
export const ALL_PASSAGES: string[] = SUPPORT_CASES.map((c) => c.passage);

/**
 * The pairs that discriminate hardest, for the passage-as-query direction.
 * Grouped: within a group all rows SHARE a passage, so the scores share a query
 * and the within-group margin is meaningful.
 */
export const DISCRIMINATING: { passage: string; assertion: string; supported: boolean; note: string; group: number }[] = [
  { group: 0, passage: SUPPORT_CASES[0].passage, assertion: 'The assessor attended the property on 12 March 2024.', supported: true, note: 'verbatim' },
  { group: 0, passage: SUPPORT_CASES[0].passage, assertion: 'Mr Patel attended the property on 12 March 2024 as the assessor.', supported: false, note: 'wrong actor' },
  { group: 0, passage: SUPPORT_CASES[0].passage, assertion: 'The assessor attended the property on 14 March 2024.', supported: false, note: 'wrong date' },
  { group: 0, passage: SUPPORT_CASES[0].passage, assertion: 'Defects were noted during the inspection.', supported: false, note: 'contradiction' },
  { group: 1, passage: SUPPORT_CASES[1].passage, assertion: 'The inspection was scheduled for 18 March 2024.', supported: true, note: 'scheduled (correct)' },
  { group: 1, passage: SUPPORT_CASES[1].passage, assertion: 'The inspection occurred on 18 March 2024.', supported: false, note: 'occurred (wrong)' },
];
