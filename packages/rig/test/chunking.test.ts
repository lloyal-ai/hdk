/**
 * The HTML chunkers address the text they build by real, contiguous line
 * ranges — not ordinals — so a consumer holding the same built text can
 * resolve any chunk, and windows over these chunks keep distinct start lines.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import { chunkFetchedPages, chunkHtml } from '../src/sources/chunking';

const LONG = (tag: string) => `${tag} paragraph with enough words in it to clear the forty character floor.`;

describe('chunkFetchedPages — real line ranges over the page text', () => {
  it('numbers each paragraph by its lines in the page text and keeps the ranges contiguous', () => {
    const text = `${LONG('First')}\nsecond line of the first\n\n${LONG('Second')}\n\n\n${LONG('Third')}`;
    const chunks = chunkFetchedPages([{ url: 'https://x/y', title: 'T', text }]);
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([[1, 2], [4, 4], [7, 7]]);
    for (const c of chunks) {
      expect(c.text.split('\n')).toHaveLength(c.endLine - c.startLine + 1);
    }
  });

  it('gives a page with no paragraph over the floor one chunk spanning its lines', () => {
    const text = `${LONG('Only')}\nand a tail line`;
    const chunks = chunkFetchedPages([{ url: 'u', title: 't', text }]);
    expect(chunks).toHaveLength(1);
    expect([chunks[0].startLine, chunks[0].endLine]).toEqual([1, 2]);
  });
});

describe('chunkHtml — real line ranges over the built text', () => {
  it('assigns contiguous, distinct line ranges across sections of one page', async () => {
    const html = `<article><h1>Intro</h1><p>${LONG('Intro')}</p><p>${LONG('More intro')}</p>` +
      `<h2>Body</h2><p>${LONG('Body')}</p></article>`;
    const chunks = await chunkHtml(html, 'https://x/y', 'T');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    let expectedStart = 1;
    for (const c of chunks) {
      expect(c.startLine).toBeGreaterThanOrEqual(expectedStart);
      expect(c.text.split('\n')).toHaveLength(c.endLine - c.startLine + 1);
      expectedStart = c.endLine + 1;
    }
    expect(new Set(chunks.map((c) => c.startLine)).size).toBe(chunks.length);
  });
});
