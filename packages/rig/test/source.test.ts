import { describe, it, expect, vi } from 'vitest';
import { NULL_SCORER } from '@lloyal-labs/lloyal-agents';
import type { EntailmentScorer } from '@lloyal-labs/lloyal-agents';
import { Source } from '../src/source';
import type { Reranker } from '../src/retrieval';
import { createMockReranker } from './helpers/mock-reranker';

// Concrete subclass for testing (Source is abstract)
class TestSource extends Source {
  readonly name = 'test';
  get tools() { return []; }

  *bind(ctx: { reranker: Reranker }) {
    this._reranker = ctx.reranker;
  }

  // Expose protected field for testing
  setFloor(floor: number) { this._entailmentFloor = floor; }
}

describe('Source.createScorer', () => {
  it('returns NULL_SCORER when no reranker', () => {
    const source = new TestSource();
    const scorer = source.createScorer('some query');
    expect(scorer).toBe(NULL_SCORER);
  });

  it('returns NULL_SCORER when empty originalQuery', () => {
    const source = new TestSource();
    (source as any)._reranker = createMockReranker();
    const scorer = source.createScorer('');
    expect(scorer).toBe(NULL_SCORER);
  });

  it('returns functional scorer when both reranker and query present', async () => {
    const scores = new Map([['relevant text', 0.8], ['irrelevant text', 0.1]]);
    const reranker = createMockReranker(scores);
    const source = new TestSource();
    (source as any)._reranker = reranker;

    const scorer = source.createScorer('original query');
    const results = await scorer.scoreEntailmentBatch(['relevant text', 'irrelevant text']);

    expect(results).toEqual([0.8, 0.1]);
  });

  it('delegates to reranker.scoreBatch with originalQuery', async () => {
    const scoreBatch = vi.fn(async (_q: string, texts: string[]) => texts.map(() => 0.5));
    const source = new TestSource();
    (source as any)._reranker = { scoreBatch } as any;

    const scorer = source.createScorer('my original query');
    await scorer.scoreEntailmentBatch(['text1', 'text2']);

    expect(scoreBatch).toHaveBeenCalledWith('my original query', ['text1', 'text2']);
  });

  it('scorer is immutable after creation', async () => {
    const reranker1 = createMockReranker(new Map([['t', 0.9]]));
    const source = new TestSource();
    (source as any)._reranker = reranker1;

    const scorer = source.createScorer('q');

    // Change the reranker on source — scorer should still use the original
    const reranker2 = createMockReranker(new Map([['t', 0.1]]));
    (source as any)._reranker = reranker2;

    const result = await scorer.scoreEntailmentBatch(['t']);
    expect(result[0]).toBe(0.9); // uses original reranker, not the new one
  });

  it('multiple scorers from same source are independent', async () => {
    const reranker = createMockReranker();
    const scoreBatch = vi.fn(async (q: string, _texts: string[]) => [q === 'query-A' ? 0.9 : 0.1]);
    (reranker as any).scoreBatch = scoreBatch;

    const source = new TestSource();
    (source as any)._reranker = reranker;

    const scorerA = source.createScorer('query-A');
    const scorerB = source.createScorer('query-B');

    const resultA = await scorerA.scoreEntailmentBatch(['t']);
    const resultB = await scorerB.scoreEntailmentBatch(['t']);

    expect(resultA[0]).toBe(0.9);
    expect(resultB[0]).toBe(0.1);
  });
});

describe('shouldProceed', () => {
  // Default floor is 0 in logit-diff space (model prefers "yes" over "no").
  // See `_entailmentFloor` doc in source.ts for the calibration rationale.
  it('returns true at default floor (0)', async () => {
    const source = new TestSource();
    (source as any)._reranker = createMockReranker();
    const scorer = source.createScorer('q');

    expect(scorer.shouldProceed(0)).toBe(true);
    expect(scorer.shouldProceed(0.01)).toBe(true);
    expect(scorer.shouldProceed(2.5)).toBe(true);
    expect(scorer.shouldProceed(-0.01)).toBe(false);
    expect(scorer.shouldProceed(-2.5)).toBe(false);
  });

  it('respects custom floor', async () => {
    const source = new TestSource();
    source.setFloor(2.0); // tighter: "confident yes"
    (source as any)._reranker = createMockReranker();
    const scorer = source.createScorer('q');

    expect(scorer.shouldProceed(2.0)).toBe(true);
    expect(scorer.shouldProceed(1.99)).toBe(false);
  });
});

describe('scoreSimilarityBatch', () => {
  it('scores texts against an arbitrary reference', async () => {
    const scores = new Map([
      ['speculative decoding on M3 Max', 0.92],
      ['unified memory architecture for inference', 0.35],
    ]);
    const reranker = createMockReranker(scores);
    const source = new TestSource();
    (source as any)._reranker = reranker;

    const scorer = source.createScorer('original query');
    const results = await scorer.scoreSimilarityBatch(
      'speculative decoding benchmarks on Apple Silicon',
      ['speculative decoding on M3 Max', 'unified memory architecture for inference'],
    );

    expect(results[0]).toBe(0.92);
    expect(results[1]).toBe(0.35);
  });

  it('uses the reference argument, not originalQuery', async () => {
    const scoreBatch = vi.fn(async (q: string, _texts: string[]) =>
      [q === 'custom ref' ? 0.99 : 0.01],
    );
    const source = new TestSource();
    (source as any)._reranker = { scoreBatch };

    const scorer = source.createScorer('original query');
    const result = await scorer.scoreSimilarityBatch('custom ref', ['t']);

    expect(scoreBatch).toHaveBeenCalledWith('custom ref', ['t']);
    expect(result[0]).toBe(0.99);
  });
});

// ── Entailment scorer integration ───────────────────────────

describe('EntailmentScorer — entailment gate logic', () => {
  function createScorer(scoreMap: Map<string, number>, floor = 0.25): EntailmentScorer {
    const reranker = createMockReranker(scoreMap);
    // Use Source.createScorer via a concrete subclass
    class TestSource extends Source {
      readonly name = 'test';
      get tools() { return []; }
    }
    const source = new TestSource();
    (source as any)._reranker = reranker;
    (source as any)._entailmentFloor = floor;
    return source.createScorer('original query about LLM speculative decoding');
  }

  it('scores above threshold pass shouldProceed', () => {
    const scorer = createScorer(new Map([['relevant question', 0.6]]));
    expect(scorer.shouldProceed(0.6)).toBe(true);
  });

  it('scores below threshold fail shouldProceed', () => {
    const scorer = createScorer(new Map(), 0.25);
    expect(scorer.shouldProceed(0.24)).toBe(false);
  });

  it('scoreEntailmentBatch returns per-text scores', async () => {
    const scores = new Map([
      ['how does LLM speculative decoding work on M3', 0.85],
      ['CPU branch prediction in Apple Silicon loops', 0.12],
      ['unified memory bandwidth for inference', 0.65],
    ]);
    const scorer = createScorer(scores);
    const results = await scorer.scoreEntailmentBatch([
      'how does LLM speculative decoding work on M3',
      'CPU branch prediction in Apple Silicon loops',
      'unified memory bandwidth for inference',
    ]);

    expect(results[0]).toBe(0.85); // on-topic: passes
    expect(results[1]).toBe(0.12); // off-topic (CPU speculation): fails
    expect(results[2]).toBe(0.65); // related: passes
  });

  it('simulates DelegateTool filtering logic', async () => {
    const scores = new Map([
      ['speculative decoding throughput on M3 Max', 0.8],
      ['how does LAP/LVP work in Apple Silicon loops', 0.12],
      ['draft model architecture tradeoffs', 0.45],
    ]);
    const scorer = createScorer(scores, 0.25);

    const tasks = [
      'speculative decoding throughput on M3 Max',
      'how does LAP/LVP work in Apple Silicon loops',
      'draft model architecture tradeoffs',
    ];

    const entailmentScores = await scorer.scoreEntailmentBatch(tasks);
    const survivors = tasks.filter((_, i) => scorer.shouldProceed(entailmentScores[i]));
    const filtered = tasks.filter((_, i) => !scorer.shouldProceed(entailmentScores[i]));

    expect(survivors).toEqual([
      'speculative decoding throughput on M3 Max',
      'draft model architecture tradeoffs',
    ]);
    expect(filtered).toEqual([
      'how does LAP/LVP work in Apple Silicon loops',
    ]);
  });

  it('all-filtered case returns empty survivors', async () => {
    const scores = new Map([
      ['irrelevant question 1', 0.1],
      ['irrelevant question 2', 0.05],
    ]);
    const scorer = createScorer(scores, 0.25);

    const tasks = ['irrelevant question 1', 'irrelevant question 2'];
    const entailmentScores = await scorer.scoreEntailmentBatch(tasks);
    const survivors = tasks.filter((_, i) => scorer.shouldProceed(entailmentScores[i]));

    expect(survivors).toEqual([]);
  });
});

// ── Scorer propagation chain ────────────────────────────────

describe('Scorer propagation', () => {
  it('scorer is immutable across depth levels', async () => {
    const scores = new Map([['q1', 0.8], ['q2', 0.3]]);
    const reranker = createMockReranker(scores);

    class TestSource extends Source {
      readonly name = 'test';
      get tools() { return []; }
    }
    const source = new TestSource();
    (source as any)._reranker = reranker;

    const scorer = source.createScorer('root query');

    // Simulate depth 0: score some tasks
    const depth0Scores = await scorer.scoreEntailmentBatch(['q1', 'q2']);
    expect(depth0Scores).toEqual([0.8, 0.3]);

    // Simulate depth 1: same scorer, same results (immutable)
    const depth1Scores = await scorer.scoreEntailmentBatch(['q1', 'q2']);
    expect(depth1Scores).toEqual([0.8, 0.3]);

    // Mutate source — scorer is unaffected
    (source as any)._reranker = createMockReranker(new Map([['q1', 0.1]]));
    const afterMutation = await scorer.scoreEntailmentBatch(['q1']);
    expect(afterMutation[0]).toBe(0.8); // still uses original reranker
  });

  it('per-source scorers are independent', async () => {
    class TestSource extends Source {
      readonly name: string;
      get tools() { return []; }
      constructor(name: string) { super(); this.name = name; }
    }

    const webSource = new TestSource('web');
    const corpusSource = new TestSource('corpus');

    const webReranker = createMockReranker(new Map([['q', 0.9]]));
    const corpusReranker = createMockReranker(new Map([['q', 0.3]]));

    (webSource as any)._reranker = webReranker;
    (corpusSource as any)._reranker = corpusReranker;

    const webScorer = webSource.createScorer('query A');
    const corpusScorer = corpusSource.createScorer('query A');

    const webResult = await webScorer.scoreEntailmentBatch(['q']);
    const corpusResult = await corpusScorer.scoreEntailmentBatch(['q']);

    expect(webResult[0]).toBe(0.9);
    expect(corpusResult[0]).toBe(0.3);
  });
});

// ── Echo detection guard ────────────────────────────────────

describe('Echo detection guard', () => {
  function createScorer(scoreMap: Map<string, number>, floor = 0.25): EntailmentScorer {
    const reranker = createMockReranker(scoreMap);
    class TestSource extends Source {
      readonly name = 'test';
      get tools() { return []; }
    }
    const source = new TestSource();
    (source as any)._reranker = reranker;
    (source as any)._entailmentFloor = floor;
    return source.createScorer('original query');
  }

  it('detects echo when all questions paraphrase agent task', async () => {
    // Agent task: "speculative decoding on Apple Silicon"
    // Proposed: near-verbatim copies → all score >0.8 against task
    const scores = new Map([
      ['speculative decoding performance on M1 M2 M3', 0.92],
      ['benchmarks for speculative decoding Apple Silicon', 0.88],
      ['Apple Silicon speculative decoding results', 0.91],
    ]);
    const scorer = createScorer(scores);

    const agentTask = 'speculative decoding on Apple Silicon';
    const proposed = [
      'speculative decoding performance on M1 M2 M3',
      'benchmarks for speculative decoding Apple Silicon',
      'Apple Silicon speculative decoding results',
    ];

    const echoScores = await scorer.scoreSimilarityBatch(agentTask, proposed);
    const minScore = Math.min(...echoScores);
    const isEcho = minScore > 0.8;

    expect(isEcho).toBe(true);
    expect(minScore).toBe(0.88);
  });

  it('allows delegation when ANY question is novel', async () => {
    // Agent task: "historical evidence of iPod-era success"
    // Proposed: 2 paraphrases + 1 discovery (Microsoft antitrust)
    const scores = new Map([
      ['iPod success evidence and market dominance', 0.90],
      ['role of U.S. v. Microsoft in Apple iPod success', 0.52],
      ['iPod adoption leading to iPhone success', 0.85],
    ]);
    const scorer = createScorer(scores);

    const agentTask = 'historical evidence of iPod-era success';
    const proposed = [
      'iPod success evidence and market dominance',
      'role of U.S. v. Microsoft in Apple iPod success',
      'iPod adoption leading to iPhone success',
    ];

    const echoScores = await scorer.scoreSimilarityBatch(agentTask, proposed);
    const minScore = Math.min(...echoScores);
    const isEcho = minScore > 0.8;

    expect(isEcho).toBe(false);
    expect(minScore).toBe(0.52); // Microsoft question is novel
  });

  it('threshold 0.8 separates paraphrase from discovery', async () => {
    // Boundary test: 0.81 is echo, 0.79 is not
    const scores = new Map([['q', 0.81]]);
    const scorer = createScorer(scores);
    const result = await scorer.scoreSimilarityBatch('task', ['q']);
    expect(result[0] > 0.8).toBe(true);

    const scores2 = new Map([['q', 0.79]]);
    const scorer2 = createScorer(scores2);
    const result2 = await scorer2.scoreSimilarityBatch('task', ['q']);
    expect(result2[0] > 0.8).toBe(false);
  });
});
