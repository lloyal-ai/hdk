/**
 * The document sidecar — facts about a document, as the content plane stores
 * them in an attachment's config slot.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import { DOCUMENT_CONFIG_TYPE, asDocumentMeta, pagesOf } from '../src/document';
import type { DocumentMeta } from '../src/document';

const page = (n: number, startLine: number, endLine: number, extra: Partial<DocumentMeta['pages'][number]> = {}) => ({
  page: n, startLine, endLine, chars: 100, imageObjects: 0, pathObjects: 0, taggedTables: 0, taggedFigures: 0, ...extra,
});

const meta: DocumentMeta = {
  title: 'A paper',
  pageCount: 3,
  sections: [{ heading: 'Intro', path: 'Intro', origin: 'heuristic', startLine: 1, endLine: 12, pageStart: 1, pageEnd: 2 }],
  pages: [page(1, 1, 8), page(2, 9, 15, { imageObjects: 1 }), page(3, 16, 20, { chars: 0 })],
  figures: [],
  tables: [],
  derive: {
    profile: 'pdf.v1', pdfium: '2.15.0', dpi: 150, maxSide: 2048, maxPixels: 4_194_304, format: 'image/png',
    renderedPages: 3, maxFigures: 16, maxTextPages: 400, tagged: false, structCoverage: 0, truncated: false,
  },
};

describe('DOCUMENT_CONFIG_TYPE', () => {
  it('is a versioned +json type, so a reader can branch on it', () => {
    expect(DOCUMENT_CONFIG_TYPE).toBe('application/vnd.lloyal.document.v1+json');
  });
});

describe('asDocumentMeta', () => {
  it('accepts the shape and returns it typed', () => {
    expect(asDocumentMeta(JSON.parse(JSON.stringify(meta)))).toEqual(meta);
  });

  it('refuses junk without throwing', () => {
    expect(asDocumentMeta(null)).toBeNull();
    expect(asDocumentMeta('x')).toBeNull();
    expect(asDocumentMeta({})).toBeNull();
    expect(asDocumentMeta({ ...meta, title: 7 })).toBeNull();
    expect(asDocumentMeta({ ...meta, pages: 'no' })).toBeNull();
    expect(asDocumentMeta({ ...meta, pages: [{ page: 1 }] })).toBeNull();
    expect(asDocumentMeta({ ...meta, sections: [{ heading: 'x' }] })).toBeNull();
  });
});

describe('pagesOf', () => {
  it('maps a line span inside one page to that page', () => {
    expect(pagesOf(meta, 2, 5)).toEqual({ pageStart: 1, pageEnd: 1 });
  });

  it('maps a span across a page break to its first and last page', () => {
    expect(pagesOf(meta, 7, 17)).toEqual({ pageStart: 1, pageEnd: 3 });
  });

  it('maps a span past the page map to the last page', () => {
    expect(pagesOf(meta, 40, 45)).toEqual({ pageStart: 3, pageEnd: 3 });
  });
});
