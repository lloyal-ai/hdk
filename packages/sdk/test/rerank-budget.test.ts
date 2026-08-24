/**
 * The per-leaf document budget, pinned term by term.
 *
 * Both the boot gate and scoring derive their budget from this one function,
 * so an error here is consistent rather than visible — every caller agrees on
 * the same wrong number. These cases fix each term independently.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import { perLeafDocBudget } from '../src/Rerank';

describe('perLeafDocBudget', () => {
  it('is the leaf slice less every surrounding segment', () => {
    // 4096/8 = 512, minus 10 + 20 + 5 + 7 = 470
    expect(perLeafDocBudget(4096, 8, 10, 20, 5, 7)).toBe(470);
  });

  it('subtracts each segment — one token more in any of them costs one token', () => {
    const base = perLeafDocBudget(4096, 8, 10, 20, 5, 7);
    expect(perLeafDocBudget(4096, 8, 11, 20, 5, 7)).toBe(base - 1); // prefix
    expect(perLeafDocBudget(4096, 8, 10, 21, 5, 7)).toBe(base - 1); // query
    expect(perLeafDocBudget(4096, 8, 10, 20, 6, 7)).toBe(base - 1); // mid
    expect(perLeafDocBudget(4096, 8, 10, 20, 5, 8)).toBe(base - 1); // suffix
  });

  it('floors the per-sequence slice rather than rounding', () => {
    // 1000/3 = 333.33 -> 333, minus 3 = 330
    expect(perLeafDocBudget(1000, 3, 1, 1, 1, 0)).toBe(330);
  });

  it('goes non-positive when the surrounding segments exceed the slice', () => {
    expect(perLeafDocBudget(100, 10, 5, 5, 5, 5)).toBe(-10);
  });
});
