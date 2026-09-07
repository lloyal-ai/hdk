/**
 * Half-open line-range arithmetic shared by the read tools' per-agent dedup.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import { mergeRanges, subtractRanges } from '../src/ranges';

describe('subtractRanges', () => {
  it('returns the target untouched when nothing is covered', () => {
    expect(subtractRanges([0, 10], [])).toEqual([[0, 10]]);
    expect(subtractRanges([0, 10], [[10, 20]])).toEqual([[0, 10]]);
  });

  it('cuts covered spans out, splitting around a hole in the middle', () => {
    expect(subtractRanges([0, 10], [[3, 5]])).toEqual([[0, 3], [5, 10]]);
    expect(subtractRanges([0, 10], [[0, 4], [6, 10]])).toEqual([[4, 6]]);
  });

  it('returns nothing when the target is fully covered', () => {
    expect(subtractRanges([2, 8], [[0, 10]])).toEqual([]);
  });
});

describe('mergeRanges', () => {
  it('collapses overlapping and touching ranges, sorted by start', () => {
    expect(mergeRanges([[5, 8], [0, 3], [3, 6]])).toEqual([[0, 8]]);
  });

  it('keeps disjoint ranges apart and an empty input empty', () => {
    expect(mergeRanges([[0, 2], [4, 6]])).toEqual([[0, 2], [4, 6]]);
    expect(mergeRanges([])).toEqual([]);
  });
});
