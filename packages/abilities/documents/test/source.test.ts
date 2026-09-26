import { describe, it, expect } from 'vitest';
import type { Reranker, Document } from '@lloyal-labs/rig';
import { DocumentsSource, buildToc } from '../src/source';
import { makeFixture, makeSecond, wordTokenize } from './helpers/fixture';

const mockReranker = { tokenize: wordTokenize } as unknown as Reranker;

describe('DocumentsSource.promptData', () => {
  it('lists each document with its page count and top-level topics, skipping an image root', () => {
    const { store, doc, image } = makeFixture();
    const second = makeSecond(store);
    const source = new DocumentsSource(store, [], mockReranker);
    expect(source.promptData([image, doc, second]).toc).toBe(
      'Fixture Paper — 4 pages (topics: Introduction, Results, Discussion, Appendix)\n' +
      'Second Report — 1 page (topics: Findings)',
    );
  });

  it('is empty for no attachments and for images only', () => {
    const { store, image } = makeFixture();
    const source = new DocumentsSource(store, [], mockReranker);
    expect(source.promptData().toc).toBe('');
    expect(source.promptData([image]).toc).toBe('');
  });
});

describe('buildToc', () => {
  const docWith = (title: string, headings: string[]): Document => ({
    meta: {
      title, pageCount: 2,
      sections: headings.map((h, i) => ({ heading: h, path: h, origin: 'heuristic' as const, startLine: i + 1, endLine: i + 1, pageStart: 1, pageEnd: 1 })),
      pages: [], figures: [], tables: [],
      derive: { profile: 'pdf.v1', pdfium: 't', dpi: 150, maxSide: 2048, maxPixels: 1, format: 'image/png', renderedPages: 0, maxFigures: 16, maxTextPages: 400, tagged: false, structCoverage: 0, truncated: false },
    },
  } as unknown as Document);

  it('strips control characters, skips nested paths and the title, and caps topics at eight', () => {
    const headings = Array.from({ length: 12 }, (_, i) => `Topic ${i + 1}`);
    const toc = buildToc([docWith('BadTitle\nHere', ['Bad Title Here', 'Outer > Inner', ...headings])]);
    expect(toc).not.toMatch(/\p{Cc}/u);
    expect(toc.startsWith('BadTitle Here — 2 pages (topics: Bad Title Here, Topic 1,')).toBe(true);
    expect(toc).not.toContain('Inner');
    expect(toc.match(/Topic \d+/g)).toHaveLength(7);
  });

  it('caps a long title', () => {
    const toc = buildToc([docWith('T'.repeat(300), [])]);
    expect(toc.length).toBeLessThan(140);
    expect(toc).toContain('…');
  });
});
