/**
 * Task profiles — the instruction, its fixtures and its threshold as one unit.
 *
 * The reranker is a pointwise instruction-following judge, so the criterion is a
 * sentence and changing the sentence changes the question the same weights
 * answer. That makes one thing dangerous: an instruction whose calibration lives
 * somewhere else. Someone improves the wording, the threshold stays put, and the
 * score quietly stops meaning what the gate assumes.
 *
 * These assert the coupling — a profile carries its own canaries, and the boot
 * gate is only as good as those fixtures. `Rerank.create` needs a real model, so
 * what is testable here is the profile contract and the prompt it produces;
 * the gate itself is exercised in the integration reranker suite.
 */
import { describe, it, expect } from 'vitest';
import { RETRIEVAL_TASK, type RerankTask } from '../src/Rerank';

describe('RETRIEVAL_TASK — the default, unchanged', () => {
  it('reproduces the instruction every caller had before profiles existed', () => {
    // Byte-identical to the old USER_PREFIX body. If this drifts, every
    // existing threshold in the field silently changes meaning.
    expect(RETRIEVAL_TASK.instruction).toBe(
      'Given a web search query, retrieve relevant passages that answer the query',
    );
  });

  it('carries the Qwen3-reranker canary pair and its 1.0 gap', () => {
    expect(RETRIEVAL_TASK.canary.query).toBe('What is the capital of France?');
    expect(RETRIEVAL_TASK.canary.positive).toMatch(/Paris is the capital/);
    expect(RETRIEVAL_TASK.canary.negative).toMatch(/Photosynthesis/);
    // Asserts SEPARATION, not sign: a model ranking both highly has not shown
    // it can tell them apart.
    expect(RETRIEVAL_TASK.canary.minGap).toBe(1.0);
  });

  it('is identified for audit', () => {
    expect(RETRIEVAL_TASK.id).toBe('retrieval/v1');
  });
});

describe('a task profile is self-contained', () => {
  const supportTask: RerankTask = {
    id: 'citation-support/v1',
    instruction:
      'Determine whether the passage supports the assertion as written, ' +
      'including its actor, date and modality',
    canary: {
      query: 'The inspection occurred on 18 March 2024.',
      positive: 'The inspection took place on 18 March 2024 and found no defects.',
      // Same topic, same date, different modality — the distinction the whole
      // chronology depends on, and one a relevance instruction would score high.
      negative: 'The inspection was scheduled for 18 March 2024 but was cancelled.',
      minGap: 1.0,
    },
  };

  it('bundles instruction, fixtures and threshold so they cannot drift apart', () => {
    // The property that matters: everything needed to interpret a score travels
    // with the score's question.
    expect(Object.keys(supportTask).sort()).toEqual(['canary', 'id', 'instruction']);
    expect(supportTask.canary.minGap).toBeGreaterThan(0);
  });

  it('a support profile needs its own canaries, not retrieval-shaped ones', () => {
    // Reusing RETRIEVAL_TASK's pair under a support instruction would pass the
    // boot gate while validating nothing — Paris/photosynthesis exercises
    // topical relevance, never whether a passage supports a claim.
    expect(supportTask.canary.positive).not.toBe(RETRIEVAL_TASK.canary.positive);
    expect(supportTask.canary.negative).not.toBe(RETRIEVAL_TASK.canary.negative);
    // And its negative must be a near-miss rather than an unrelated topic:
    // both canary documents mention the same inspection and the same date.
    expect(supportTask.canary.negative).toMatch(/18 March 2024/);
  });
});
