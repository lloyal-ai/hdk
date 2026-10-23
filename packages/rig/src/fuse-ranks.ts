/**
 * @file Reciprocal rank fusion: several rankings become one by rank alone.
 *
 * Rankings from different senses or retrievers (what was heard, seen and said;
 * lexical and dense) score on scales that cannot be compared, so they are
 * combined by where each item stands, never by its score. An item gains
 * 1 / (k + rank) from each ranking it is in, its rank counted from 1 (Cormack,
 * Clarke and Büttcher, 2009); k = 60 keeps one first place from outweighing
 * broad agreement.
 *
 * Pure: an ability, a harness and a test read the same fusion.
 */

/** One fused moment: the items that are one, its fused score, and its position in each ranking, counted from 0
 *  (so first scores 1 / (k + 1)), or null where it is absent. */
export interface Fused<T> {
  members: T[];
  score: number;
  ranks: (number | null)[];
}

export interface FuseOpts<T> {
  /** Weighs the top of each ranking against agreement across them; smaller weighs the top more. Default 60. */
  k?: number;
  /** Whether two items are one moment, such as time ranges that overlap. Items it joins are one, transitively.
   *  Default: the same value. */
  same?: (a: T, b: T) => boolean;
}

/**
 * The rankings fused into one, best first. Ties go to the better best rank,
 * then to the order the rankings were given. Comparing every pair of items,
 * it is meant for shortlists, not whole corpora.
 *
 * @throws When `k` is not a positive number.
 *
 * @category Rig
 */
export function fuseRanks<T>(rankings: readonly (readonly T[])[], opts: FuseOpts<T> = {}): Fused<T>[] {
  const { k = 60, same = Object.is } = opts;
  if (!(k > 0)) throw new RangeError(`fuseRanks: k must be a positive number, not ${k}`);
  const entries = rankings.flatMap((ranking, which) => ranking.map((item, rank) => ({ item, which, rank })));

  // Items that are one moment share a root: union-find over every pair the caller's rule joins.
  const root = entries.map((_, i) => i);
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])));
  entries.forEach((a, i) => entries.slice(i + 1).forEach((b, j) => {
    if (same(a.item, b.item)) root[find(i + 1 + j)] = find(i);
  }));

  const moments = new Map<number, typeof entries>();
  entries.forEach((entry, i) => moments.set(find(i), [...(moments.get(find(i)) ?? []), entry]));

  const fused = [...moments.values()].map((members) => {
    const ranks = rankings.map((_, which) => {
      const here = members.filter(m => m.which === which).map(m => m.rank);
      return here.length > 0 ? Math.min(...here) : null;
    });
    return {
      // The same item ranked by several rankings is one member.
      members: [...new Set(members.map(m => m.item))],
      score: ranks.reduce<number>((sum, rank) => (rank === null ? sum : sum + 1 / (k + rank + 1)), 0),
      ranks,
      best: Math.min(...members.map(m => m.rank)),
    };
  });
  // Map order is first appearance, so a stable sort settles the last tie by the order the rankings were given.
  return fused
    .sort((a, b) => b.score - a.score || a.best - b.best)
    .map(({ members, score, ranks }) => ({ members, score, ranks }));
}
