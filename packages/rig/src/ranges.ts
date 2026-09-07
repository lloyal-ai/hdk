/**
 * @file Half-open line-range arithmetic.
 *
 * Shared by the read tools that remember which lines each agent has already
 * been shown, so a second read returns only what is new. Pure; ranges are
 * `[start, end)`.
 */

/**
 * The parts of `target` not covered by any range in `covered`, in order.
 *
 * @category Rig
 */
export function subtractRanges(
  [s, e]: [number, number],
  covered: readonly [number, number][],
): [number, number][] {
  let ranges: [number, number][] = [[s, e]];
  for (const [cs, ce] of covered) {
    ranges = ranges.flatMap(([a, b]): [number, number][] => {
      if (ce <= a || cs >= b) return [[a, b]];
      const result: [number, number][] = [];
      if (a < cs) result.push([a, cs]);
      if (ce < b) result.push([ce, b]);
      return result;
    });
  }
  return ranges;
}

/**
 * Overlapping or touching ranges collapsed into the minimal set, sorted by start.
 *
 * @category Rig
 */
export function mergeRanges(ranges: readonly [number, number][]): [number, number][] {
  if (ranges.length === 0) return [];
  const sorted = ranges.map(([a, b]): [number, number] => [a, b]).sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i][0] <= last[1]) last[1] = Math.max(last[1], sorted[i][1]);
    else merged.push(sorted[i]);
  }
  return merged;
}
