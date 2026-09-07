/**
 * Okapi-BM25 first-stage retriever
 *
 * Pure-JS lexical scorer. Built once at corpus boot from chunk.tokens (the
 * reranker-tokenized chunk vocabulary), queried at search time to narrow the
 * cross-encoder workload from the whole corpus down to a manageable top-K.
 *
 * Why BM25 and not embeddings: BM25 is a good lexical bouncer, not a semantic
 * judge. It reliably surfaces chunks that lexically overlap the query (high
 * recall on the kind of vocabulary users actually type). The cross-encoder
 * reranker is what disambiguates semantics — BM25's job is just to keep its
 * candidate pool wide enough that the cross-encoder's eventual winners are in
 * the top-K. Default K=100 is generous for typical 1k-10k chunk corpora; if
 * recall ever degrades on a synonym-rich vocabulary, hybrid retrieval
 * (BM25 ∪ embedding-top-K) is the escape hatch (3.x ticket).
 *
 * Reference: https://en.wikipedia.org/wiki/Okapi_BM25
 *
 *   score(q, d) = Σ_t  idf(t) * (tf(t,d) * (k1+1)) /
 *                       (tf(t,d) + k1 * (1 - b + b * |d| / avgdl))
 *
 *   idf(t)  = log(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
 *
 * Defaults k1=1.5, b=0.75 are the well-known Okapi-BM25 tuning that lands well
 * for most corpora.
 */

export interface Bm25Opts {
  /** Term-frequency saturation parameter. Default 1.5. */
  k1?: number;
  /** Length-normalization parameter (0=off, 1=full). Default 0.75. */
  b?: number;
}

export interface Bm25Hit {
  /** Position in the original docs array passed to the index constructor. */
  index: number;
  /** BM25 score (additive over query terms; not bounded). */
  score: number;
}

/**
 * Pre-built per-document statistics for fast scoring. Built once per corpus.
 */
export class BM25Index {
  private readonly _k1: number;
  private readonly _b: number;
  /** Per-document length in tokens; index aligns with constructor input. */
  private readonly _docLengths: Int32Array;
  /** avg(doc_length) used in length normalization. */
  private readonly _avgDocLen: number;
  /** term token id → idf(t) */
  private readonly _idf: Map<number, number>;
  /**
   * Per-document term frequencies. `_docTermFreq[i].get(term)` returns the
   * count of `term` in doc `i`, or undefined if absent. Maps are sparse — a
   * 30-token document has ≤ 30 keys.
   */
  private readonly _docTermFreq: Array<Map<number, number>>;

  constructor(docTokens: number[][], opts: Bm25Opts = {}) {
    this._k1 = opts.k1 ?? 1.5;
    this._b = opts.b ?? 0.75;

    const N = docTokens.length;
    this._docLengths = new Int32Array(N);
    this._docTermFreq = new Array(N);

    // Per-doc term frequencies + document frequencies in one pass.
    const docFreq = new Map<number, number>();
    for (let i = 0; i < N; i++) {
      const doc = docTokens[i];
      this._docLengths[i] = doc.length;
      const tf = new Map<number, number>();
      for (let k = 0; k < doc.length; k++) {
        const t = doc[k];
        tf.set(t, (tf.get(t) ?? 0) + 1);
      }
      this._docTermFreq[i] = tf;
      for (const term of tf.keys()) {
        docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      }
    }

    let totalLen = 0;
    for (let i = 0; i < N; i++) totalLen += this._docLengths[i];
    this._avgDocLen = N > 0 ? totalLen / N : 0;

    // Okapi-smoothed IDF — always ≥ 0 via the +1 inside log.
    this._idf = new Map();
    for (const [term, df] of docFreq) {
      this._idf.set(term, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
    }
  }

  /**
   * Score every document against `queryTokens`; return hits sorted by score
   * descending. Optional `topK` truncates.
   */
  score(queryTokens: number[], topK?: number): Bm25Hit[] {
    const N = this._docLengths.length;
    const scores = new Float32Array(N);

    // Dedupe query terms but accumulate weight per occurrence — BM25's per-
    // query-term loop is over distinct terms, but if a user types "Paris
    // Paris" we shouldn't double-count idf. Common convention: count each
    // distinct query term once.
    const queryTermSet = new Set<number>(queryTokens);

    for (const t of queryTermSet) {
      const idf = this._idf.get(t);
      if (idf === undefined) continue; // term not in corpus → no contribution

      for (let i = 0; i < N; i++) {
        const tf = this._docTermFreq[i].get(t);
        if (tf === undefined) continue;
        const docLen = this._docLengths[i];
        const numerator = tf * (this._k1 + 1);
        const denominator =
          tf +
          this._k1 * (1 - this._b + (this._b * docLen) / this._avgDocLen);
        scores[i] += idf * (numerator / denominator);
      }
    }

    const hits: Bm25Hit[] = new Array(N);
    for (let i = 0; i < N; i++) hits[i] = { index: i, score: scores[i] };
    hits.sort((a, b) => b.score - a.score);
    return topK != null && topK < hits.length ? hits.slice(0, topK) : hits;
  }

  /** Number of documents indexed. */
  get size(): number {
    return this._docLengths.length;
  }
}
