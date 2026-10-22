/**
 * @file A vector index over Matryoshka embeddings, searched coarse to fine.
 *
 * A model trained to be cut to several widths (EmbeddingGemma 2: 768, 512, 256
 * and 128) answers every width from one encode: each shorter vector is a prefix
 * of the full one. So an index can keep entries at a width it chooses, scan
 * everything cheaply at a narrow width, and rescore what that scan keeps at a
 * wider one. Two vectors are only ever compared at one width: both are cut to
 * it and made unit length again, and only full-width vectors come in, so a
 * comparison of mixed widths cannot be written.
 *
 * Pure: an ability, a harness and a test search the same way.
 */

export interface VectorIndexOpts {
  /** The widths the model was trained to be cut to, its full width among them. */
  widths: readonly number[];
  /** The width entries are kept at: one of `widths`, the full width by default. A narrower one keeps a long
   *  index small, and no search can then compare wider than it. */
  stored?: number;
}

export interface VectorSearchOpts {
  /** How many entries to answer. */
  k: number;
  /** The width the answer is decided at: one of the trained widths, at most the stored one, which is the default. */
  width?: number;
  /** A first pass over every entry at a narrower width, keeping `keep` of them for the answer to decide among.
   *  `keep` must exceed what the question has to find: a shortlist smaller than the answers drops answers. */
  scan?: { width: number; keep: number };
}

export interface VectorHit<T> {
  item: T;
  /** Cosine similarity at the width the answer was decided at. */
  score: number;
}

/** `vector` cut to its first `width` dimensions and made unit length again.
 *  @throws When the cut has no direction: a zero or non-finite length, whose cosine has no value. */
function cut(vector: Float32Array, width: number): Float32Array {
  const head = vector.slice(0, width);
  const norm = Math.hypot(...head);
  if (!(norm > 0 && Number.isFinite(norm))) {
    throw new RangeError(`the vector's first ${width} values have no direction, so a ${width}-wide cosine has no value`);
  }
  return head.map(x => x / norm);
}

const dot = (a: Float32Array, b: Float32Array): number => a.reduce((sum, x, i) => sum + x * b[i], 0);

/**
 * Entries added with their full-width vector, searched by a full-width query.
 *
 * @category Rig
 */
export class VectorIndex<T> {
  private readonly widths: readonly number[];
  private readonly full: number;
  private readonly stored: number;
  /** The widths an entry can be compared at: the trained ones up to the stored width, widest first. */
  private readonly comparableWidths: readonly number[];
  private readonly entries: { item: T; vector: Float32Array }[] = [];

  /** @throws When `stored` is not a trained width. */
  constructor(opts: VectorIndexOpts) {
    this.widths = [...opts.widths].sort((a, b) => b - a);
    this.full = this.widths[0];
    this.stored = this.trained(opts.stored ?? this.full);
    this.comparableWidths = this.widths.filter((width) => width <= this.stored);
  }

  get size(): number {
    return this.entries.length;
  }

  /** @throws When `vector` is not the full width, or has no direction at a width it could be compared at. */
  add(item: T, vector: Float32Array): void {
    // Cut at every width it can be compared at, so one with no direction is refused now, not at a search; the
    // widest, the stored width, is what is kept.
    const full = this.fullWidth(vector);
    const [kept] = this.comparableWidths.map((width) => cut(full, width));
    this.entries.push({ item, vector: kept });
  }

  /**
   * The `k` entries closest to `query`, best first: scored at `width`, among every entry or among those a
   * narrower `scan` kept.
   *
   * @throws When a width is untrained or wider than the stored one, the scan is not narrower than the answer,
   *         it keeps fewer than `k`, or `query` is not the full width or has no direction at a width compared.
   */
  search(query: Float32Array, opts: VectorSearchOpts): VectorHit<T>[] {
    const { k, scan } = opts;
    const width = this.comparable(opts.width ?? this.stored);
    this.fullWidth(query);
    if (scan) {
      this.comparable(scan.width);
      if (scan.width >= width) throw new RangeError(`a scan must be narrower than the answer's width ${width}, not ${scan.width}`);
      if (scan.keep < k) throw new RangeError(`a scan that keeps ${scan.keep} cannot answer ${k}`);
    }
    const pool = scan ? this.closest(query, scan.width, this.entries, scan.keep).map(h => h.entry) : this.entries;
    return this.closest(query, width, pool, k).map(({ entry, score }) => ({ item: entry.item, score }));
  }

  /** The `n` entries of `pool` closest to `query` at `width`, best first. */
  private closest(query: Float32Array, width: number, pool: typeof this.entries, n: number) {
    const q = cut(query, width);
    return pool
      .map(entry => ({ entry, score: dot(q, cut(entry.vector, width)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, n);
  }

  private trained(width: number): number {
    if (!this.widths.includes(width)) {
      const named = this.widths.slice(0, -1).join(', ') + ` or ${this.widths[this.widths.length - 1]}`;
      throw new RangeError(`the model was trained to be cut to ${named}, not ${width}`);
    }
    return width;
  }

  private comparable(width: number): number {
    if (!this.comparableWidths.includes(this.trained(width))) throw new RangeError(`entries are stored at ${this.stored}; they cannot be compared at ${width}`);
    return width;
  }

  private fullWidth(vector: Float32Array): Float32Array {
    if (vector.length !== this.full) throw new RangeError(`a vector must be the full width, ${this.full}, not ${vector.length}`);
    return vector;
  }
}
