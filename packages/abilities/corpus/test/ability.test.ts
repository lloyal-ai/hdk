import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from 'effection';
import { AbilityConfigStoreCtx, RerankerCtx, Trace, NullTraceWriter } from '@lloyal-labs/lloyal-agents';
import type { Reranker, ScoredChunk } from '@lloyal-labs/rig';
import type { Chunk } from '@lloyal-labs/lloyal-agents';
import { createInMemoryConfigStore } from '@lloyal-labs/rig';
import { createCorpusAbility } from '../src/index';
import { SearchTool } from '../src/tools/search';

// The factory fits the corpus into windows at construction, which needs only
// the reranker's tokenizer; search scoring (a real cross-encoder) isn't
// exercised here. Words stand in for tokens.
const mockReranker = {
  tokenize: async (text: string) => text.split(/\s+/).filter(Boolean).map((_, i) => i + 1),
} as unknown as Reranker;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'corpus-app-'));
  writeFileSync(join(dir, 'doc.md'), '# Title\n\nSome corpus content about transformer architecture.\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('createCorpusAbility', () => {
  it('builds the corpus_research ability with full tool-map coverage', async () => {
    const ability = await run(function* () {
      const store = createInMemoryConfigStore();
      yield* store.set('corpus', { corpusPath: dir });
      yield* AbilityConfigStoreCtx.set(store);
      yield* RerankerCtx.set(mockReranker);
      return yield* createCorpusAbility();
    });

    expect(ability.manifest.protocol.name).toBe('corpus_research');
    expect(ability.source.name).toBe('corpus');
    expect(ability.tools.map((t) => t.name).sort()).toEqual(['grep', 'read_file', 'search']);
  });

  it('throws a clear error when no reranker is set', async () => {
    await expect(
      run(function* () {
        const store = createInMemoryConfigStore();
        yield* store.set('corpus', { corpusPath: dir });
        yield* AbilityConfigStoreCtx.set(store);
        return yield* createCorpusAbility();
      }),
    ).rejects.toThrow(/requires a reranker/);
  });

  it('fits a long section into more than one window with real line ranges', async () => {
    // One heading over 360 words on 60 lines: longer than DEFAULT_CHUNK_TOKENS
    // under the word tokenizer, so the factory must cut it into windows the
    // reranker can score whole. The source keeps its chunks private; the
    // search envelope's `totalScored` is the chunk count, and each hit carries
    // the window's real lines.
    const longDir = mkdtempSync(join(tmpdir(), 'corpus-long-'));
    const body = Array.from({ length: 60 }, (_, i) => `line ${i + 1} alpha beta gamma delta`).join('\n');
    writeFileSync(join(longDir, 'long.md'), `# Long\n\n${body}\n`);
    try {
      const wordy: Reranker = {
        ...mkScoringReranker(new Map()),
        tokenize: async (text: string) => text.split(/\s+/).filter(Boolean).map((_, i) => i + 1),
        score(_query: string, chunks: Chunk[]) {
          return (async function* () {
            yield {
              filled: chunks.length, total: chunks.length,
              results: chunks.map((c) => ({
                file: c.resource, heading: c.heading, section: c.section, snippet: c.text,
                score: 1, startLine: c.startLine, endLine: c.endLine,
              })),
            };
          })();
        },
      };
      const result = (await run(function* () {
        yield* Trace.set(new NullTraceWriter());
        const store = createInMemoryConfigStore();
        yield* store.set('corpus', { corpusPath: longDir });
        yield* AbilityConfigStoreCtx.set(store);
        yield* RerankerCtx.set(wordy);
        const ability = yield* createCorpusAbility();
        const search = ability.tools.find((t) => t.name === 'search')!;
        return yield* search.execute({ query: 'alpha' });
      })) as { hits: ScoredChunk[]; totalScored: number };

      expect(result.totalScored).toBeGreaterThan(1);
      const starts = result.hits.map((h) => h.startLine);
      expect(new Set(starts).size).toBe(starts.length);
      for (const h of result.hits) {
        expect(h.endLine).toBeGreaterThanOrEqual(h.startLine);
        expect(h.startLine).toBeGreaterThanOrEqual(1);
        expect(h.endLine).toBeLessThanOrEqual(62);
      }
    } finally {
      rmSync(longDir, { recursive: true, force: true });
    }
  });

  it('throws when corpusPath config is missing', async () => {
    await expect(
      run(function* () {
        yield* AbilityConfigStoreCtx.set(createInMemoryConfigStore());
        yield* RerankerCtx.set(mockReranker);
        return yield* createCorpusAbility();
      }),
    ).rejects.toThrow(/corpusPath/);
  });
});

// ── SearchTool envelope ──────────────────────────────────────────
//
// What comes back is `{hits, totalScored}`: the ranking's top-K within a token
// budget, each hit keeping the file and line range `read_file` is addressed by.
// No score decides admission. The reranker is a RELATIVE judge — its scale
// shifts per query and its top-ranked candidate goes negative routinely — so a
// floor at zero returned nothing exactly when the agent most needed the best
// available passages.

/** A fixture `Chunk`. Line ranges are distinct because the admission pipeline
 *  locates a scored chunk by file AND start line. */
function mkChunk(file: string, heading: string, startLine: number, tokenCount = 3): Chunk {
  return {
    resource: file,
    heading,
    section: heading,
    text: `body of ${heading}`,
    tokens: Array.from({ length: tokenCount }, (_, i) => i + 1),
    startLine,
    endLine: startLine + 4,
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
    // The double must carry the WHOLE contract: `tokenize` returns tokens from
    // the reranker's own vocabulary (BM25's first stage needs them). Omitting
    // it compiled only because no tsc project covered this file.
    tokenize: async (_text: string) => [],
    dispose: () => {},
  };
}

describe('SearchTool envelope', () => {
  const searchWith = (chunks: Chunk[], scores: Map<string, number>, opts?: { topK?: number; tokenBudget?: number }, context?: unknown) => {
    const tool = new SearchTool(chunks, mkScoringReranker(scores), opts);
    return run(function* () {
      yield* Trace.set(new NullTraceWriter());
      return (yield* tool.execute({ query: 'q' }, context as never)) as { hits: ScoredChunk[]; totalScored: number };
    });
  };

  it('an all-negative ranking still returns its best — no score decides admission', async () => {
    // Every chunk is a "probably not" by the model's own judgement, which on a
    // real corpus is the common case, not the failure case. The agent gets the
    // ranking and the scores, and decides for itself.
    const chunks = [mkChunk('a.md', 'cake', 1), mkChunk('a.md', 'weather', 11), mkChunk('b.md', 'tls', 1)];
    const result = await searchWith(chunks, new Map([['cake', -1.2], ['weather', -2.5], ['tls', -3.0]]));

    expect(result.hits.map((h) => h.heading)).toEqual(['cake', 'weather', 'tls']);
    expect(result.totalScored).toBe(3);
    expect(result.hits[0]).toMatchObject({ file: 'a.md', startLine: 1, endLine: 5, score: -1.2 });
  });

  it('hits are the ranking in order, each addressed the way read_file takes it', async () => {
    const chunks = [mkChunk('a.md', 'high', 1), mkChunk('a.md', 'medium', 11), mkChunk('b.md', 'low', 1)];
    const result = await searchWith(chunks, new Map([['high', 5.5], ['medium', 1.2], ['low', -2.0]]));

    expect(result.hits.map((h) => h.heading)).toEqual(['high', 'medium', 'low']);
    expect(result.hits.map((h) => [h.file, h.startLine, h.endLine])).toEqual([
      ['a.md', 1, 5], ['a.md', 11, 15], ['b.md', 1, 5],
    ]);
  });

  it("scores in explore mode whatever the run's stance — the corpus is the on-topic universe, so the original question never vetoes a passage", async () => {
    // Measured on the pharmacology thread at q8_0 KV: exploit's min() against
    // the original question took the answer-bearing passage from +5.5 to −5.0.
    // A scorer that throws proves the exploit pass is never consulted here.
    const chunks = [mkChunk('a.md', 'high', 1), mkChunk('a.md', 'medium', 11)];
    const scorer = { scoreEntailmentBatch: async () => { throw new Error('the entailment scorer must not be consulted for a corpus search'); } };
    const r = await searchWith(chunks, new Map([['high', 5.5], ['medium', 1.2]]), undefined,
      { attachments: [], explore: false, scorer });
    expect(r.hits.map((h) => h.heading)).toEqual(['high', 'medium']);
  });

  it('topK bounds the count; the token budget bounds the payload', async () => {
    const chunks = [mkChunk('a.md', 'high', 1), mkChunk('a.md', 'medium', 11), mkChunk('b.md', 'low', 1)];
    const scores = new Map([['high', 5.5], ['medium', 1.2], ['low', -2.0]]);

    expect((await searchWith(chunks, scores, { topK: 2 })).hits.map((h) => h.heading)).toEqual(['high', 'medium']);

    // Three tokens per chunk, so a budget of four fits exactly one.
    expect((await searchWith(chunks, scores, { tokenBudget: 4 })).hits.map((h) => h.heading)).toEqual(['high']);
  });
});
