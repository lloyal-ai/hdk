import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from 'effection';
import { AppConfigStoreCtx, RerankerCtx, Trace, NullTraceWriter } from '@lloyal-labs/lloyal-agents';
import type { Reranker, ScoredChunk } from '@lloyal-labs/rig';
import type { Chunk } from '@lloyal-labs/lloyal-agents';
import { createInMemoryConfigStore } from '@lloyal-labs/rig';
import { createCorpusApp } from '../src/index';
import { SearchTool } from '../src/tools/search';

// The factory only calls reranker.tokenizeChunks at construction; search
// scoring (which needs a real cross-encoder) isn't exercised here.
const mockReranker = { tokenizeChunks() {} } as unknown as Reranker;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'corpus-app-'));
  writeFileSync(join(dir, 'doc.md'), '# Title\n\nSome corpus content about transformer architecture.\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('createCorpusApp', () => {
  it('builds the corpus_research app with full tool-map coverage', async () => {
    const app = await run(function* () {
      const store = createInMemoryConfigStore();
      yield* store.set('corpus', { corpusPath: dir });
      yield* AppConfigStoreCtx.set(store);
      yield* RerankerCtx.set(mockReranker);
      return yield* createCorpusApp();
    });

    expect(app.manifest.protocol.name).toBe('corpus_research');
    expect(app.source.name).toBe('corpus');
    expect(app.tools.map((t) => t.name).sort()).toEqual(['grep', 'read_file', 'search']);
  });

  it('throws a clear error when no reranker is set', async () => {
    await expect(
      run(function* () {
        const store = createInMemoryConfigStore();
        yield* store.set('corpus', { corpusPath: dir });
        yield* AppConfigStoreCtx.set(store);
        return yield* createCorpusApp();
      }),
    ).rejects.toThrow(/requires a reranker/);
  });

  it('throws when corpusPath config is missing', async () => {
    await expect(
      run(function* () {
        yield* AppConfigStoreCtx.set(createInMemoryConfigStore());
        yield* RerankerCtx.set(mockReranker);
        return yield* createCorpusApp();
      }),
    ).rejects.toThrow(/corpusPath/);
  });
});

// ── SearchTool envelope (TICK-001) ───────────────────────────────
//
// SearchTool now returns `{hits, thresholdScore, totalScored, topRejected}`
// instead of a raw `ScoredChunk[]`. The threshold gives the agent an
// honest "0 hits above the floor" signal — when nothing passes, the
// envelope still surfaces the top 3 rejected hits so the agent sees
// "best I could find, but the model said no to all of them" rather
// than getting fed garbage as if it were honest signal.

/** Build a fixture `Chunk` with the minimum fields SearchTool reads. */
function mkChunk(file: string, heading: string, score: number): Chunk {
  return {
    resource: file,
    heading,
    section: heading,
    text: `body of ${heading}`,
    tokens: [1, 2, 3],
    startLine: 1,
    endLine: 5,
  };
}

/**
 * Reranker mock that yields a controllable score per chunk. Score is
 * read off `expectedScores` keyed by `chunk.heading`.
 */
function mkScoringReranker(expectedScores: Map<string, number>): Reranker {
  return {
    score(_query: string, chunks: Chunk[]): AsyncIterable<{ filled: number; total: number; results: ScoredChunk[] }> {
      return {
        async *[Symbol.asyncIterator]() {
          const results: ScoredChunk[] = chunks
            .map((c) => ({
              file: c.resource,
              heading: c.heading,
              section: c.section,
              snippet: c.text,
              score: expectedScores.get(c.heading) ?? 0,
              startLine: c.startLine,
              endLine: c.endLine,
            }))
            .sort((a, b) => b.score - a.score);
          yield { filled: chunks.length, total: chunks.length, results };
        },
      };
    },
    scoreBatch: async (_q, texts) => texts.map(() => 0),
    tokenizeChunks: async () => {},
    dispose: () => {},
  };
}

describe('SearchTool envelope (TICK-001)', () => {
  it('returns hits + envelope; drops sub-threshold hits to topRejected when empty', async () => {
    // Three chunks; all score below threshold=0. No hits should pass; the
    // envelope must surface up to 3 topRejected so the agent sees "best
    // I could find, but the model said no."
    const chunks = [
      mkChunk('a.md', 'cake', -1.2),
      mkChunk('a.md', 'weather', -2.5),
      mkChunk('b.md', 'tls', -3.0),
    ];
    const reranker = mkScoringReranker(
      new Map([['cake', -1.2], ['weather', -2.5], ['tls', -3.0]]),
    );
    const tool = new SearchTool(chunks, reranker, { threshold: 0 });

    const result = (await run(function* () {
      yield* Trace.set(new NullTraceWriter());
      return yield* tool.execute({ query: 'q' }) as Generator<unknown, unknown, unknown>;
    })) as { hits: ScoredChunk[]; thresholdScore: number; totalScored: number; topRejected: ScoredChunk[] };

    expect(result.hits).toEqual([]);
    expect(result.thresholdScore).toBe(0);
    expect(result.totalScored).toBe(3);
    expect(result.topRejected.length).toBe(3);
    // topRejected is sorted high-to-low so the agent sees the best of the
    // bad first.
    expect(result.topRejected[0].heading).toBe('cake'); // -1.2 is least bad
    expect(result.topRejected[2].heading).toBe('tls');  // -3.0 is worst
  });

  it('returns hits above threshold; topRejected is empty when any hit passes', async () => {
    const chunks = [
      mkChunk('a.md', 'high',   5.5),
      mkChunk('a.md', 'medium', 1.2),
      mkChunk('b.md', 'low',   -2.0),
    ];
    const reranker = mkScoringReranker(
      new Map([['high', 5.5], ['medium', 1.2], ['low', -2.0]]),
    );
    const tool = new SearchTool(chunks, reranker, { threshold: 0 });

    const result = (await run(function* () {
      yield* Trace.set(new NullTraceWriter());
      return yield* tool.execute({ query: 'q' }) as Generator<unknown, unknown, unknown>;
    })) as { hits: ScoredChunk[]; thresholdScore: number; totalScored: number; topRejected: ScoredChunk[] };

    expect(result.hits.map((h) => h.heading)).toEqual(['high', 'medium']);
    expect(result.thresholdScore).toBe(0);
    expect(result.totalScored).toBe(3);
    expect(result.topRejected).toEqual([]); // not surfaced when hits is non-empty
  });

  it('respects custom threshold (tighter floor)', async () => {
    const chunks = [
      mkChunk('a.md', 'high',   5.5),
      mkChunk('a.md', 'medium', 1.2),
    ];
    const reranker = mkScoringReranker(new Map([['high', 5.5], ['medium', 1.2]]));
    // Tighter threshold of 2 ⇒ only "confident yes" hits pass.
    const tool = new SearchTool(chunks, reranker, { threshold: 2 });

    const result = (await run(function* () {
      yield* Trace.set(new NullTraceWriter());
      return yield* tool.execute({ query: 'q' }) as Generator<unknown, unknown, unknown>;
    })) as { hits: ScoredChunk[]; thresholdScore: number };

    expect(result.hits.map((h) => h.heading)).toEqual(['high']);
    expect(result.thresholdScore).toBe(2);
  });
});
