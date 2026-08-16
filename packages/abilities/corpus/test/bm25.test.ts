/**
 * Unit tests for BM25Index. Pure JS — no model dependency, so this runs in
 * standard vitest without integration setup.
 */

import { describe, it, expect } from 'vitest';
import { BM25Index } from '../src/bm25';

// Synthetic token vocabulary — small integers for readability. In production
// these come from the reranker's BPE tokenizer.
const T = {
  paris: 1,
  france: 2,
  capital: 3,
  amazon: 4,
  rainforest: 5,
  oxygen: 6,
  berlin: 7,
  germany: 8,
  photosynthesis: 9,
  glucose: 10,
  is: 100, // common stopword-like
  the: 101,
};

describe('BM25Index', () => {
  it('ranks the lexically-matching doc first on a single-term query', () => {
    const docs = [
      [T.paris, T.is, T.the, T.capital], // 0 — Paris-doc
      [T.amazon, T.rainforest, T.oxygen],
      [T.berlin, T.is, T.the, T.capital, T.germany], // 2 — Berlin/capital
      [T.photosynthesis, T.glucose],
    ];
    const index = new BM25Index(docs);
    const hits = index.score([T.paris]);
    expect(hits[0].index).toBe(0);
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('idf weights rare terms higher than common ones (paris > the for Paris-doc)', () => {
    const docs = [
      [T.paris, T.is, T.the, T.capital], // 0
      [T.berlin, T.is, T.the, T.capital, T.germany], // 1
      [T.amazon, T.is, T.the, T.rainforest], // 2
      [T.photosynthesis, T.glucose], // 3
    ];
    const index = new BM25Index(docs);
    // "paris" appears in 1 doc; "the" appears in 3 docs.
    // For Paris-doc, paris-token alone should outscore the-token alone.
    const parisOnly = index.score([T.paris]);
    const theOnly = index.score([T.the]);
    // Both rank Paris-doc somewhere, but the score on paris-only must be
    // higher because the idf for "paris" is larger.
    expect(parisOnly[0].score).toBeGreaterThan(theOnly[0].score);
  });

  it('multi-term queries sum contributions; matching multiple terms scores higher', () => {
    const docs = [
      [T.paris, T.is, T.the, T.capital, T.france], // 0 — matches both
      [T.paris, T.is, T.a, T.city], // 1 — matches one (paris only)
      [T.berlin, T.germany], // 2 — matches none
    ];
    const index = new BM25Index(docs);
    const hits = index.score([T.paris, T.france]);
    expect(hits[0].index).toBe(0);
    expect(hits[1].index).toBe(1);
  });

  it('topK truncates results', () => {
    const docs = [
      [T.paris, T.capital],
      [T.paris, T.is, T.the, T.capital],
      [T.berlin, T.capital],
      [T.amazon],
      [T.photosynthesis],
    ];
    const index = new BM25Index(docs);
    const top2 = index.score([T.paris, T.capital], 2);
    expect(top2.length).toBe(2);
  });

  it('zero score for terms not in any document', () => {
    const docs = [
      [T.paris, T.capital],
      [T.berlin, T.capital],
    ];
    const index = new BM25Index(docs);
    // 9999 is a vocab token never seen.
    const hits = index.score([9999]);
    expect(hits[0].score).toBe(0);
    expect(hits[1].score).toBe(0);
  });

  it('returns hits sorted by score descending', () => {
    const docs = [
      [T.paris],
      [T.paris, T.paris], // tf=2; should outrank tf=1 (saturation curve still rewards)
      [T.paris, T.paris, T.paris], // tf=3
      [T.amazon],
    ];
    const index = new BM25Index(docs);
    const hits = index.score([T.paris]);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i].score).toBeLessThanOrEqual(hits[i - 1].score);
    }
  });

  it('size reflects document count', () => {
    const docs = [[T.paris], [T.berlin], [T.amazon]];
    expect(new BM25Index(docs).size).toBe(3);
  });

  it('length normalization (b parameter) — shorter doc with the same tf scores higher than longer one', () => {
    // Short doc with the term once vs long doc with the term once.
    // With default b=0.75, the shorter doc should score higher (more
    // distinctive that the term appeared).
    const short = [T.paris];
    const long = [T.paris, T.is, T.a, T.city, T.in, 200, 201, 202, 203, 204, 205, 206];
    const index = new BM25Index([short, long]);
    const hits = index.score([T.paris]);
    expect(hits[0].index).toBe(0); // short doc
  });

  it('dedupes query terms — repeated query token does not double-count', () => {
    const docs = [
      [T.paris, T.capital],
      [T.berlin, T.capital],
    ];
    const index = new BM25Index(docs);
    const a = index.score([T.paris])[0].score;
    const b = index.score([T.paris, T.paris])[0].score;
    expect(b).toBe(a);
  });
});
