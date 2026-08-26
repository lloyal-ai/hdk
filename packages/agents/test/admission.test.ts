/**
 * admitChunks — the platform's ONE retrieval-admission pipeline: scoring,
 * explore/exploit dual scoring, the selection gate, and the trace events
 * that make the funnel observable. Both shipped disciplines are covered:
 * budget (page-content) and threshold (corpus).
 */
import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import { Trace } from '../src/context';
import { admitChunks } from '../src/admission';
import type { Chunk, Reranker } from '../src/chunk';
import { CapturingTraceWriter } from './helpers/capturing-trace';

function mkChunks(n: number, tokensEach = 100): Chunk[] {
  return Array.from({ length: n }, (_, i) => ({
    resource: 'page', heading: `H${i}`, section: '',
    text: `text of chunk ${i} `.repeat(10),
    tokens: Array.from({ length: tokensEach }, () => 1),
    startLine: i * 10, endLine: i * 10 + 9,
  }));
}

/** Scores descend with index: chunk 0 scores highest. */
function mkReranker(): Reranker {
  return {
    score: async function* (_q: string, chunks: Chunk[]) {
      yield {
        filled: chunks.length, total: chunks.length,
        results: chunks.map((c, i) => ({
          file: c.resource, heading: c.heading, score: 10 - i,
          startLine: c.startLine, endLine: c.endLine,
        })),
      };
    },
  } as unknown as Reranker;
}

async function admit(opts: Parameters<typeof admitChunks>[4], chunks: Chunk[], context?: Parameters<typeof admitChunks>[3]) {
  const tw = new CapturingTraceWriter();
  const result = await run(function* () {
    yield* Trace.set(tw);
    return yield* admitChunks(mkReranker(), chunks, 'the query', context, opts);
  });
  return { result, tw };
}

describe('admitChunks — budget mode', () => {
  it('admits top-K within the token budget and records the full funnel', async () => {
    const chunks = mkChunks(6, 100);
    const { result, tw } = await admit(
      { tool: 'fetch_page', url: 'https://x', select: { mode: 'budget', topK: 5, tokenBudget: 250 } },
      chunks,
    );
    // 100-token chunks into a 250 budget: two fit.
    expect(result.passages!.map(p => p.heading)).toEqual(['H0', 'H1']);
    expect(result.admittedTokens).toBe(200);
    // Everything scored-but-cut becomes the discovery signal.
    expect(result.alsoOnPage).toEqual(['H2', 'H3', 'H4', 'H5']);

    const end = tw.ofType('rerank:end')[0];
    expect(end.topK).toBe(5);
    expect(end.tokenBudget).toBe(250);
    expect(end.admittedTokens).toBe(200);
    expect(end.totalScored).toBe(6);
    expect(end.selectedPassageCount).toBe(2);
    expect(end.url).toBe('https://x');
  });

  it('truncates the first chunk on a paragraph boundary when it alone busts the budget', async () => {
    const chunks = mkChunks(2, 500);
    const { result } = await admit(
      { tool: 'fetch_page', select: { mode: 'budget', topK: 5, tokenBudget: 50 } },
      chunks,
    );
    expect(result.passages).toHaveLength(1);
    expect(result.passages![0].text.endsWith('[truncated]')).toBe(true);
  });
});

describe('admitChunks — threshold mode', () => {
  it('admits at the floor and records it', async () => {
    const { result, tw } = await admit(
      { tool: 'search', select: { mode: 'threshold', threshold: 8 } },
      mkChunks(6),
    );
    // Scores are 10..5 — three clear the floor of 8.
    expect(result.admitted!.map(r => r.heading)).toEqual(['H0', 'H1', 'H2']);
    expect(result.topRejected).toEqual([]);
    const end = tw.ofType('rerank:end')[0];
    expect(end.threshold).toBe(8);
    expect(end.totalScored).toBe(6);
  });

  it('surfaces topRejected when NOTHING passes — best-I-could-find, honestly labeled', async () => {
    const { result } = await admit(
      { tool: 'search', select: { mode: 'threshold', threshold: 100 } },
      mkChunks(6),
    );
    expect(result.admitted).toEqual([]);
    expect(result.topRejected!.map(r => r.heading)).toEqual(['H0', 'H1', 'H2']);
  });
});

describe('admitChunks — exploit re-rank', () => {
  it('re-sorts by the entailment score and traces both flavors', async () => {
    const chunks = mkChunks(3);
    const { result, tw } = await admit(
      { tool: 'fetch_page', select: { mode: 'budget', topK: 3, tokenBudget: 10_000 } },
      chunks,
      {
        agentId: 1,
        explore: false,
        pressurePercentAvailable: 33,
        // Reverses the tool-query order: chunk 2's text entails the query best.
        scorer: { scoreRelevanceBatch: async (texts: string[]) => texts.map((_, i) => i) } as any,
      },
    );
    expect(result.scored.map(s => s.heading)).toEqual(['H2', 'H1', 'H0']);

    const exploit = tw.ofType('entailment:content:exploit')[0];
    expect(exploit.pressure).toEqual({ percentAvailable: 33 });
    // The reorder is the story: toolQueryScore ranked H0 first, combined ranks it last.
    expect(exploit.chunks[0]).toMatchObject({ heading: 'H2', toolQueryScore: 8, combinedScore: 2 });
  });

  it('stays agent-local in explore mode — no exploit event, no reorder', async () => {
    const { result, tw } = await admit(
      { tool: 'fetch_page', select: { mode: 'budget', topK: 3, tokenBudget: 10_000 } },
      mkChunks(3),
      { agentId: 1, explore: true, scorer: { scoreRelevanceBatch: async () => [9, 9, 9] } as any },
    );
    expect(result.scored.map(s => s.heading)).toEqual(['H0', 'H1', 'H2']);
    expect(tw.ofType('entailment:content:exploit')).toHaveLength(0);
  });
});
