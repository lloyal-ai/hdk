/**
 * @file Passages sized for a reranker leaf, by lines.
 *
 * Pure: it knows nothing about rerankers beyond the `tokenize` it is handed,
 * and nothing about where chunks came from. The size is a retrieval choice the
 * caller makes; the reranker's capacity is the reranker's own affair. Kept
 * free of `./files` on purpose — that module statically imports the native
 * package, and nothing on the platform-agnostic barrel may depend on it — so
 * the paragraph splitter lives here and `./files` imports it.
 */
import type { Chunk } from '@lloyal-labs/lloyal-agents';

/**
 * Default passage size, in tokens of the scoring reranker's vocabulary.
 *
 * A granularity, not a capacity: passages of a few hundred tokens are what
 * first-stage and cross-encoder retrieval work best over, whatever the
 * hardware. It is sized so that a passage of this length plus a 64-token
 * query fits the smallest reranker sizing rig ships (nSeqMax 10 · nCtx 4096),
 * which `test/reranker-capacity.test.ts` pins against real weights.
 *
 * @category Rig
 */
export const DEFAULT_CHUNK_TOKENS = 256;

/**
 * Half-open line ranges `[start, end)` of the blank-separated paragraphs in
 * `lines`. A whitespace-only line is blank; runs of blank lines separate
 * exactly as one does.
 *
 * @category Rig
 */
export function splitParagraphs(lines: readonly string[]): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= lines.length; i++) {
    const blank = i === lines.length || lines[i].trim() === '';
    if (!blank && start < 0) start = i;
    if (blank && start >= 0) {
      out.push([start, i]);
      start = -1;
    }
  }
  return out;
}

/** What {@link fitChunks} needs: a size, and the tokenizer whose vocabulary the size is in. */
export interface FitOpts {
  /** Longest window, in tokens. Positive integer. */
  maxTokens: number;
  /** The scoring reranker's tokenizer — chunk tokens must be in ITS vocabulary. */
  tokenize: (text: string) => Promise<number[]>;
}

/**
 * Cut chunks into windows of at most `maxTokens`, returning them tokenized.
 *
 * A chunk within the size is returned whole. A longer one is split on its
 * own line structure: whole paragraphs are packed greedily into windows, a
 * paragraph over the size is packed by lines, and a single line over the size
 * stays one window — the reranker head-truncates it. **Never inside a line**:
 * admission joins scored chunks back to their source by `(resource,
 * startLine)`, so two windows must never share a start line. Windows tile
 * their parent's non-blank lines, carry real `startLine`/`endLine`, inherit
 * `resource`, `heading` and `section`, and never overlap (BM25 would count
 * the overlap twice).
 *
 * Every window is measured once more after packing, so the tokens it carries
 * are exactly what the reranker will score — not a sum of its parts.
 *
 * @throws When `maxTokens` is not a positive integer: an uncapped chunker is
 *         a configuration error, never a silent fallback.
 *
 * @category Rig
 */
export async function fitChunks(chunks: readonly Chunk[], opts: FitOpts): Promise<Chunk[]> {
  const { maxTokens, tokenize } = opts;
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new Error(`fitChunks: maxTokens must be a positive integer, got ${String(maxTokens)}`);
  }

  const out: Chunk[] = [];
  for (const chunk of chunks) {
    const tokens = await tokenize(chunk.text);
    if (tokens.length <= maxTokens) {
      out.push({ ...chunk, tokens });
      continue;
    }

    const lines = chunk.text.split('\n');
    const slice = (s: number, e: number): string => lines.slice(s, e).join('\n');

    // Units to pack: paragraphs, or the lines of a paragraph too long to be one.
    const units: [number, number][] = [];
    for (const [s, e] of splitParagraphs(lines)) {
      const n = (await tokenize(slice(s, e))).length;
      if (n <= maxTokens) units.push([s, e]);
      else for (let i = s; i < e; i++) units.push([i, i + 1]);
    }

    // Greedy packing of consecutive units; a candidate window is measured
    // exactly rather than summed, because tokenization is not additive across
    // the joins.
    let ws = -1;
    let we = -1;
    const flush = async (): Promise<void> => {
      if (ws < 0) return;
      const text = slice(ws, we);
      out.push({
        ...chunk,
        text,
        tokens: await tokenize(text),
        startLine: chunk.startLine + ws,
        endLine: chunk.startLine + we - 1,
      });
      ws = -1;
      we = -1;
    };
    for (const [s, e] of units) {
      if (ws < 0) { ws = s; we = e; continue; }
      if ((await tokenize(slice(ws, e))).length <= maxTokens) { we = e; continue; }
      await flush();
      ws = s;
      we = e;
    }
    await flush();
  }
  return out;
}
