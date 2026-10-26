/**
 * Reciprocal rank fusion: rankings from different senses or retrievers become
 * one, by rank alone, so scores that cannot be compared never are.
 */
import { describe, expect, it } from 'vitest';
import { fuseRanks } from '../src/fuse-ranks';

describe('fuseRanks', () => {
  it('scores each item 1 / (k + its rank) in every ranking it is in, k 60 by default', () => {
    const fused = fuseRanks([['a', 'b'], ['b', 'c']]);
    expect(fused.map(f => f.members)).toEqual([['b'], ['a'], ['c']]);
    expect(fused[0].score).toBeCloseTo(1 / 62 + 1 / 61);
    expect(fused[1].score).toBeCloseTo(1 / 61);
    // Each moment says where it stood in each ranking, and where it was absent.
    expect(fused.map(f => f.ranks)).toEqual([[1, 0], [0, null], [null, 1]]);
  });

  it('puts an item two senses agree on above one only a single sense ranks first', () => {
    const heard = ['window 3', 'window 9', 'window 1'];
    const said = ['window 9', 'window 4'];
    expect(fuseRanks([heard, said])[0].members).toEqual(['window 9']);
  });

  it('merges items of different rankings that are one moment, and joins them transitively', () => {
    type Span = { sense: string; startMs: number; endMs: number };
    const overlaps = (a: Span, b: Span) => a.startMs < b.endMs && b.startMs < a.endMs;
    const seen: Span[] = [{ sense: 'seen', startMs: 12_000, endMs: 20_000 }, { sense: 'seen', startMs: 40_000, endMs: 48_000 }];
    const said: Span[] = [{ sense: 'said', startMs: 10_000, endMs: 15_000 }, { sense: 'said', startMs: 19_000, endMs: 24_000 }];
    const fused = fuseRanks([seen, said], { same: overlaps });
    // The seen window at 12-20 s overlaps both said passages, so all three are one moment.
    expect(fused[0].members.map(m => `${m.sense} ${m.startMs}`)).toEqual(['seen 12000', 'said 10000', 'said 19000']);
    expect(fused[0].ranks).toEqual([0, 0]);
    expect(fused[1].members.map(m => `${m.sense} ${m.startMs}`)).toEqual(['seen 40000']);
  });

  it('breaks a tie by the best rank, then by the order the rankings were given', () => {
    expect(fuseRanks([['a', 'x'], ['b', 'y']]).map(f => f.members[0])).toEqual(['a', 'b', 'x', 'y']);
  });

  it('takes a smaller k to weigh the top of each ranking more', () => {
    // At k 1, first in one ranking (1/2) beats fourth in two (1/5 + 1/5); at 60, fourth in two wins.
    const rankings = [['solo', 'p', 'q', 'shared'], ['other', 'r', 's', 'shared']];
    expect(fuseRanks(rankings, { k: 1 })[0].members).toEqual(['solo']);
    expect(fuseRanks(rankings)[0].members).toEqual(['shared']);
  });

  it('refuses a k that is not positive, naming it', () => {
    expect(() => fuseRanks([['a']], { k: 0 })).toThrow(/k must be a positive number/);
  });

  it('answers nothing for no rankings', () => {
    expect(fuseRanks([])).toEqual([]);
  });
});
