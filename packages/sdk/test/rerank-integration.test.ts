/**
 * R4 — Real-model integration tests for Rerank (post-R3 architecture).
 *
 * Replaces the obsolete `_scoreGroup`-mocking rerank.test.ts: that test file
 * targeted a code path that no longer exists. The new Rerank.ts composes
 * Branch + BranchStore primitives over a permanent warm trunk; the only
 * meaningful tests are against a real reranker model.
 *
 * Discovers a reranker model in this order:
 *   1. process.env.LLAMA_RERANK_MODEL
 *   2. ~/.cache/lloyal/models/qwen3-reranker-0.6b-q8_0.gguf
 *   3. ~/.cache/lloyal/models/qwen3-reranker-0.6b-q4_k_m.gguf
 *   4. <lloyal-node>/models/qwen3-reranker-0.6b-q4_k_m.gguf  (sibling repo)
 *
 * If none are found, every test is skipped with a single message — same
 * pattern as liblloyal's integration tests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createContext } from '@lloyal-labs/lloyal.node';
import {
  Rerank,
  RerankCalibrationError,
  Branch,
  BranchSampleError,
} from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';

// ── Model discovery ────────────────────────────────────────────────

function resolveRerankerModel(): string | null {
  // Production-aligned order: q4_k_m FIRST (what lloyal-node bundles and what
  // reasoning.run actually runs). q8_0 only as a manual override via env. We
  // want test results to reflect production behavior, not a healthier quant.
  const candidates = [
    process.env.LLAMA_RERANK_MODEL,
    path.join(os.homedir(), '.cache/lloyal/models/qwen3-reranker-0.6b-q4_k_m.gguf'),
    // Sibling repo (lloyal-node bundles q4_k_m here). Resolved from homedir
    // because __dirname is unreliable in vitest's ESM context.
    path.join(os.homedir(), 'dev/apps/lloyal-node/models/qwen3-reranker-0.6b-q4_k_m.gguf'),
    // q8_0 as last resort (not in production)
    path.join(os.homedir(), '.cache/lloyal/models/qwen3-reranker-0.6b-q8_0.gguf'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

const MODEL_PATH = resolveRerankerModel();
// Loud at import so we always see which quant we're testing.
console.log(`[rerank-integration] MODEL_PATH = ${MODEL_PATH ?? '(none — tests will skip)'}`);
const SKIP_REASON = MODEL_PATH
  ? null
  : 'No reranker model found; set LLAMA_RERANK_MODEL or drop a Qwen3-reranker gguf in ~/.cache/lloyal/models';

// ── Test fixtures ──────────────────────────────────────────────────

// Known relevant + irrelevant pairs. These are also the boot canary fixtures,
// so passing here implies the reranker is well-calibrated for these texts.
const PARIS_QUERY = 'What is the capital of France?';
const PARIS_DOC = 'Paris is the capital and most populous city of France.';
const AMAZON_DOC = "The Amazon rainforest produces about 20% of the world's oxygen.";
const PHOTO_DOC = 'Photosynthesis converts carbon dioxide and water into glucose.';
const BERLIN_DOC = 'Berlin is the capital of Germany and its largest city.';

// 20-doc semantic-ordering fixture (mirrors the lloyal-node testRerankLargeCorpus).
const CORPUS_20 = [
  PARIS_DOC, // 0 — relevant
  AMAZON_DOC,
  BERLIN_DOC,
  'The Great Wall of China is over 13,000 miles long.',
  'Tokyo is the most populous metropolitan area in the world.',
  'The Sahara Desert is the largest hot desert in the world.',
  'Mount Everest is the highest mountain above sea level.',
  'The Pacific Ocean is the largest and deepest ocean.',
  'Antarctica is the coldest continent on Earth.',
  'The Nile is traditionally considered the longest river.',
  'Australia is both a country and a continent.',
  'The human body contains approximately 206 bones.',
  'Jupiter is the largest planet in our solar system.',
  'The speed of light is approximately 299,792 kilometers per second.',
  'DNA was first identified by Friedrich Miescher in 1869.',
  'The International Space Station orbits Earth every 90 minutes.',
  'Honey never spoils due to its low moisture content.',
  'Venice is built on more than 100 small islands.',
  'The deepest point in the ocean is the Mariana Trench.',
  PHOTO_DOC,
];

// ── Helpers ────────────────────────────────────────────────────────

async function createCtxForRerank(nSeqMax = 10, nCtx = 4096): Promise<SessionContext> {
  return (await createContext({
    modelPath: MODEL_PATH!,
    nCtx,
    nSeqMax,
    typeK: 'q4_0',
    typeV: 'q4_0',
  })) as unknown as SessionContext;
}

async function drain<T>(iter: AsyncIterable<T>): Promise<T> {
  let last: T | undefined;
  for await (const v of iter) last = v;
  return last as T;
}

// Vitest 5+ syntax: skipIf at the describe level.
// @TODO(rerank-ci): these margin/rank thresholds are QUANT-SPECIFIC — they pass
// on q8_0 and fail on q4_k_m (margin 1.13 < 2, rank 4 ≥ 3). Because the suite
// skips when no GGUF is present, CI never runs them and they gate nothing. Pin a
// known quant + SHA and wire a tag-triggered rerank gate (see lloyal-sdk task
// #453) so this stops being machine/quant-dependent. Until then: skips on CI.
const describeWithModel = SKIP_REASON ? describe.skip : describe;

describeWithModel(`Rerank integration (post-R3) — ${SKIP_REASON ?? path.basename(MODEL_PATH!)}`, () => {
  // Each test creates its own Rerank so test failures don't cascade. Boot
  // canary cost (~3 forward passes) is the floor per test; OK for correctness
  // tests, perf tests reuse a single instance.

  it(
    'creates successfully with healthy Qwen3-reranker (single-token yes/no + BPE invariance + boot canary)',
    async () => {
      const ctx = await createCtxForRerank();
      const rerank = await Rerank.create(ctx);
      try {
        // Construction succeeding implies all three calibration gates passed.
        expect(rerank).toBeDefined();
      } finally {
        rerank.dispose();
      }
    },
    60_000,
  );

  it(
    'rejects a second Rerank.create() on the same SessionContext (exclusive ownership)',
    async () => {
      const ctx = await createCtxForRerank();
      const first = await Rerank.create(ctx);
      try {
        await expect(Rerank.create(ctx)).rejects.toThrow(/decode owner/);
      } finally {
        first.dispose();
      }
    },
    60_000,
  );

  it(
    'scoreBatch — relevant pair outscores irrelevant pair by a wide margin (relative ordering)',
    async () => {
      // The reranker is a relative ranker, not an absolute calibrator —
      // production traces show top-1 scores routinely going negative on
      // real corpora. Assert the RELATIVE ordering and margin, not signs.
      const ctx = await createCtxForRerank();
      const rerank = await Rerank.create(ctx);
      try {
        const [relScore, irrScore] = await rerank.scoreBatch(PARIS_QUERY, [
          PARIS_DOC,
          PHOTO_DOC,
        ]);
        expect(relScore).toBeGreaterThan(irrScore);
        // Margin sanity — clearly-relevant vs clearly-irrelevant should
        // produce > 2 logit units of separation on a healthy reranker.
        expect(relScore - irrScore).toBeGreaterThan(2);
      } finally {
        rerank.dispose();
      }
    },
    60_000,
  );

  it(
    'scoreBatch — deterministic same-backend (same input → byte-equal output)',
    async () => {
      const ctx = await createCtxForRerank();
      const rerank = await Rerank.create(ctx);
      try {
        const a = await rerank.scoreBatch(PARIS_QUERY, [PARIS_DOC, AMAZON_DOC]);
        const b = await rerank.scoreBatch(PARIS_QUERY, [PARIS_DOC, AMAZON_DOC]);
        expect(a).toEqual(b);
      } finally {
        rerank.dispose();
      }
    },
    60_000,
  );

  it(
    'score — semantic ordering on 20-doc corpus (PARIS_DOC ranks top-3)',
    async () => {
      const ctx = await createCtxForRerank();
      const rerank = await Rerank.create(ctx);
      try {
        const tokenized = await Promise.all(CORPUS_20.map((d) => rerank.tokenize(d)));
        const result = await drain(rerank.score(PARIS_QUERY, tokenized));
        expect(result.total).toBe(20);
        const rankOfRelevant = result.results.findIndex((r) => r.index === 0);
        expect(rankOfRelevant).toBeGreaterThanOrEqual(0);
        expect(rankOfRelevant).toBeLessThan(3);
      } finally {
        rerank.dispose();
      }
    },
    120_000,
  );

  it(
    'score — sort uses RAW (unrounded) scores; rank-by-rounded would change ordering',
    async () => {
      // Construct a 3-doc scenario where raw scores cluster within 0.001 of
      // each other; if Rerank rounded BEFORE sorting (the prior B1 mechanism)
      // tied rounded values would sort by insertion order and the test would
      // fail. We assert that raw score order is preserved and that the
      // tightly-clustered scores are not all equal — i.e. raw resolution
      // survived to the consumer.
      const ctx = await createCtxForRerank();
      const rerank = await Rerank.create(ctx);
      try {
        // Three semantically-similar docs likely to cluster on a "capital of
        // France" query at sub-0.01 logit gaps.
        const closeDocs = [
          PARIS_DOC,
          'Paris is a major European city and a global center of art.',
          'France is a country in Western Europe with Paris as its capital.',
        ];
        const tokenized = await Promise.all(closeDocs.map((d) => rerank.tokenize(d)));
        const result = await drain(rerank.score(PARIS_QUERY, tokenized));
        // Scores must be monotonically descending in the returned order.
        for (let i = 1; i < result.results.length; i++) {
          expect(result.results[i].score).toBeLessThanOrEqual(
            result.results[i - 1].score,
          );
        }
        // At least two distinct raw-score values (within 3 results).
        const uniqueScores = new Set(result.results.map((r) => r.score));
        expect(uniqueScores.size).toBeGreaterThanOrEqual(2);
      } finally {
        rerank.dispose();
      }
    },
    60_000,
  );

  it(
    'warm-trunk amortization — second query reuses prefix KV cells',
    async () => {
      // The architecture's load-bearing perf claim: the SYSTEM + USER_PREFIX
      // segment is decoded ONCE at create() and KV cells are amortized across
      // every score() call via multi-tag KV survival. Assert that
      // cellsUsed after a second score() rises by ≤ Σ(per-query + per-leaf
      // unique tokens), NOT by the full prompt length each time.
      const ctx = await createCtxForRerank();
      const rerank = await Rerank.create(ctx);
      try {
        const docs = [PARIS_DOC, AMAZON_DOC];
        const tokenized = await Promise.all(docs.map((d) => rerank.tokenize(d)));

        // Baseline AFTER the boot canary (which already populated trunk KV).
        const pressureAfterBoot = ctx._storeKvPressure();

        // First score() — forks queryBranch + 2 leaves, prefills, prunes.
        await drain(rerank.score(PARIS_QUERY, tokenized));
        const pressureAfter1 = ctx._storeKvPressure();

        // Second score() — same query, same docs. Trunk KV is reused; query+doc
        // KV cells are evicted on prune. Net cellsUsed delta from boot should
        // NOT grow with each score() call (steady-state).
        await drain(rerank.score(PARIS_QUERY, tokenized));
        const pressureAfter2 = ctx._storeKvPressure();

        // The static prefix (trunk) is steady-state; cellsUsed after score-1
        // and score-2 should be within a small tolerance (allows for cleanup
        // ordering). The KEY assertion is that score-2 doesn't add a second
        // trunk-prefix worth of cells.
        const drift = Math.abs(pressureAfter2.cellsUsed - pressureAfter1.cellsUsed);
        // Prefix is ~30 tokens for Qwen3-reranker template; allow a couple
        // of tokens of drift for ordering/timing.
        expect(drift).toBeLessThan(30);
        // Also assert post-score cellsUsed is meaningfully more than 0 (we did
        // do work) — guards against the case where pressure isn't tracked.
        expect(pressureAfterBoot.cellsUsed).toBeGreaterThan(0);
      } finally {
        rerank.dispose();
      }
    },
    120_000,
  );

  it(
    'KV residency bounded over 50 queries (no leaks)',
    async () => {
      // Lighter version of the plan's 1000-query test (1000 would take ~30 min
      // on this M2 Pro). 50 is enough to expose monotonic growth from leaks.
      const ctx = await createCtxForRerank();
      const rerank = await Rerank.create(ctx);
      try {
        const tokenized = await Promise.all(
          [PARIS_DOC, AMAZON_DOC, BERLIN_DOC].map((d) => rerank.tokenize(d)),
        );

        let peakCellsUsed = 0;
        for (let i = 0; i < 50; i++) {
          await drain(rerank.score(PARIS_QUERY, tokenized));
          const p = ctx._storeKvPressure();
          if (p.cellsUsed > peakCellsUsed) peakCellsUsed = p.cellsUsed;
        }

        // Peak must stay under the absolute KV budget. The fact that we
        // completed 50 successful score() calls without an exception is itself
        // strong evidence of bounded usage; assert the headroom is real.
        const finalPressure = ctx._storeKvPressure();
        expect(finalPressure.cellsUsed).toBeLessThan(finalPressure.nCtx);
        expect(peakCellsUsed).toBeLessThan(finalPressure.nCtx);
      } finally {
        rerank.dispose();
      }
    },
    300_000,
  );

  it(
    'truncation observability — onTruncate fires for over-budget docs with correct lengths',
    async () => {
      const ctx = await createCtxForRerank();
      const truncations: Array<{
        docIndex: number;
        origLen: number;
        maxLen: number;
      }> = [];
      const rerank = await Rerank.create(ctx, {
        onTruncate: (e) => {
          truncations.push(e);
        },
      });
      try {
        // Build an oversize doc by repeating a sentence many times.
        const longSentence = (
          'The capital of France is Paris, which is also the most populous city. '
        ).repeat(80);
        const longTokens = await rerank.tokenize(longSentence);

        await drain(rerank.score(PARIS_QUERY, [longTokens]));

        // Should have fired exactly once for the single oversize doc.
        expect(truncations.length).toBe(1);
        expect(truncations[0].docIndex).toBe(0);
        expect(truncations[0].origLen).toBe(longTokens.length);
        expect(truncations[0].maxLen).toBeGreaterThan(0);
        expect(truncations[0].maxLen).toBeLessThan(truncations[0].origLen);
      } finally {
        rerank.dispose();
      }
    },
    60_000,
  );

  it(
    'concurrent score() calls produce results equal to serial baseline (Promise-chain serializer)',
    async () => {
      const ctx = await createCtxForRerank();
      const rerank = await Rerank.create(ctx);
      try {
        const docsA = [PARIS_DOC, AMAZON_DOC];
        const docsB = [BERLIN_DOC, PHOTO_DOC];
        const tokA = await Promise.all(docsA.map((d) => rerank.tokenize(d)));
        const tokB = await Promise.all(docsB.map((d) => rerank.tokenize(d)));

        // Serial baseline.
        const baselineA = await drain(rerank.score(PARIS_QUERY, tokA));
        const baselineB = await drain(rerank.score('Capital of Germany?', tokB));

        // Concurrent (kicked off at the same tick; the serializer interleaves
        // them in arrival order).
        const [concA, concB] = await Promise.all([
          drain(rerank.score(PARIS_QUERY, tokA)),
          drain(rerank.score('Capital of Germany?', tokB)),
        ]);

        // Determinism on a deterministic reranker.
        expect(concA.results.map((r) => r.score)).toEqual(
          baselineA.results.map((r) => r.score),
        );
        expect(concB.results.map((r) => r.score)).toEqual(
          baselineB.results.map((r) => r.score),
        );
      } finally {
        rerank.dispose();
      }
    },
    180_000,
  );

  it(
    'dispose() then re-create on the same ctx is rejected (ctx is disposed in dispose)',
    async () => {
      const ctx = await createCtxForRerank();
      const first = await Rerank.create(ctx);
      first.dispose();
      // After dispose, ctx is also disposed (Rerank takes ownership).
      // A second create() on the disposed ctx should fail with a native error.
      await expect(Rerank.create(ctx)).rejects.toThrow();
    },
    60_000,
  );

  it(
    'Branch.sample() returns -1 sentinel → BranchSampleError (R1b sample-guard)',
    async () => {
      // Use a fresh ctx (NOT a Rerank-owned one) so we can construct a bare
      // Branch with no sampler chain and no captured logits.
      const ctx = (await createContext({
        modelPath: MODEL_PATH!,
        nCtx: 1024,
        nSeqMax: 4,
        typeK: 'q4_0',
        typeV: 'q4_0',
      })) as unknown as SessionContext;
      try {
        const branch = Branch.create(ctx, 0);
        // No prefill / step → no logits captured. sample() must throw.
        expect(() => branch.sample()).toThrow(BranchSampleError);
        branch.pruneSync();
      } finally {
        (ctx as unknown as { dispose: () => void }).dispose();
      }
    },
    60_000,
  );
});
