/**
 * `fitChunks` — passages sized for a reranker leaf, by lines.
 *
 * A word-count tokenizer makes every expectation readable by hand. The size
 * is a granularity choice the caller makes; the function knows nothing about
 * rerankers beyond the tokenize it is handed.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import type { Chunk } from '@lloyal-labs/lloyal-agents';
import { fitChunks, splitParagraphs, DEFAULT_CHUNK_TOKENS } from '../src/resources/fit';

const words = async (text: string): Promise<number[]> =>
  text.split(/\s+/).filter(Boolean).map((_, i) => i + 1);

function chunk(text: string, startLine = 1, extra: Partial<Chunk> = {}): Chunk {
  const lines = text.split('\n');
  return {
    resource: 'doc.md', heading: 'H', section: 'A > H', text, tokens: [],
    startLine, endLine: startLine + lines.length - 1, ...extra,
  };
}

const PARA = (n: number, w = 'w') => Array.from({ length: n }, () => w).join(' ');

describe('splitParagraphs', () => {
  it('returns half-open line ranges of blank-separated paragraphs, skipping blank runs', () => {
    const lines = ['a', 'b', '', '', 'c', '', 'd', 'e', 'f'];
    expect(splitParagraphs(lines)).toEqual([[0, 2], [4, 5], [6, 9]]);
  });

  it('treats whitespace-only lines as blank and an empty input as no paragraphs', () => {
    expect(splitParagraphs(['  ', 'x', ' \t', 'y'])).toEqual([[1, 2], [3, 4]]);
    expect(splitParagraphs([])).toEqual([]);
  });
});

describe('fitChunks', () => {
  it('exports a default passage size', () => {
    expect(DEFAULT_CHUNK_TOKENS).toBe(256);
  });

  it('keeps a chunk within the size as one tokenized window', async () => {
    const c = chunk(`${PARA(4)}\n\n${PARA(3)}`, 10);
    const out = await fitChunks([c], { maxTokens: 10, tokenize: words });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ startLine: 10, endLine: 12, text: c.text });
    expect(out[0].tokens).toHaveLength(7);
  });

  it('packs whole paragraphs into windows that tile the parent lines, inheriting heading and section', async () => {
    // 6 + 6 + 6 words: two fit in ten? no — 6+6 = 12 > 10, so one paragraph per window.
    const c = chunk(`${PARA(6)}\n\n${PARA(6)}\n\n${PARA(6)}`, 1);
    const out = await fitChunks([c], { maxTokens: 10, tokenize: words });
    expect(out.map((w) => [w.startLine, w.endLine])).toEqual([[1, 1], [3, 3], [5, 5]]);
    for (const w of out) {
      expect(w.tokens.length).toBeLessThanOrEqual(10);
      expect(w.heading).toBe('H');
      expect(w.section).toBe('A > H');
      expect(w.resource).toBe('doc.md');
      expect(w.text.split('\n')).toHaveLength(w.endLine - w.startLine + 1);
    }
  });

  it('packs consecutive short paragraphs together, keeping the blank lines between them', async () => {
    const c = chunk(`${PARA(3)}\n\n${PARA(3)}\n\n${PARA(3)}\n\n${PARA(3)}`, 1);
    const out = await fitChunks([c], { maxTokens: 10, tokenize: words });
    // 3+3+3 = 9 ≤ 10, then 3.
    expect(out.map((w) => [w.startLine, w.endLine])).toEqual([[1, 5], [7, 7]]);
    expect(out[0].tokens).toHaveLength(9);
  });

  it('splits a paragraph over the size by lines', async () => {
    const c = chunk([PARA(4), PARA(4), PARA(4)].join('\n'), 20);
    const out = await fitChunks([c], { maxTokens: 10, tokenize: words });
    expect(out.map((w) => [w.startLine, w.endLine])).toEqual([[20, 21], [22, 22]]);
  });

  it('keeps a single line longer than the size as one window and never splits inside a line', async () => {
    const c = chunk(`${PARA(3)}\n${PARA(25)}\n${PARA(3)}`, 5);
    const out = await fitChunks([c], { maxTokens: 10, tokenize: words });
    expect(out.map((w) => [w.startLine, w.endLine])).toEqual([[5, 5], [6, 6], [7, 7]]);
    expect(out[1].tokens).toHaveLength(25);
  });

  it('never yields two windows with the same (resource, startLine)', async () => {
    const c = chunk(`${PARA(30)}\n\n${PARA(30)}`, 1);
    const out = await fitChunks([c], { maxTokens: 10, tokenize: words });
    const keys = out.map((w) => `${w.resource}:${w.startLine}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('preserves input order across chunks and resources', async () => {
    const a = chunk(PARA(3), 1, { resource: 'a.md' });
    const b = chunk(`${PARA(8)}\n\n${PARA(8)}`, 1, { resource: 'b.md' });
    const out = await fitChunks([a, b], { maxTokens: 10, tokenize: words });
    expect(out.map((w) => `${w.resource}:${w.startLine}`)).toEqual(['a.md:1', 'b.md:1', 'b.md:3']);
  });

  it('throws on a size below one instead of silently not capping', async () => {
    await expect(fitChunks([chunk('x')], { maxTokens: 0, tokenize: words })).rejects.toThrow(/maxTokens/);
  });
});
