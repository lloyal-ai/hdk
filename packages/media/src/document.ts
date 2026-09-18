/**
 * @file The document sidecar — facts about a document, kept in its manifest's
 * config slot.
 *
 * Pure data and a guard, browser-safe like `attachment.ts`. A document
 * attachment has ONE representation, `text/markdown`; its page renders and
 * figure crops are ordinary single-image attachments named here by root
 * descriptor. This file records facts only — counts, spans, roots, the
 * derivation parameters — and no policy: which pages are worth projecting is
 * a rule whoever consumes the sidecar applies over the counts.
 */
import type { Descriptor } from './attachment';

/** The config media type a document manifest carries; a reader branches on it. */
export const DOCUMENT_CONFIG_TYPE = 'application/vnd.lloyal.document.v1+json' as const;

/**
 * Where a section came from: the PDF's structure tree, its bookmarks, or the
 * font-size heuristics applied when neither covered the page.
 */
export type SectionOrigin = 'struct' | 'bookmark' | 'heuristic';

/**
 * The sidecar. Lines are 1-based over the markdown representation's `\n`
 * split — the `Chunk.startLine` convention — and the page map is the
 * authority for line → page; the markdown carries no page anchors. Descriptors
 * are complete so a consumer can hand them straight to `asAttachment`.
 *
 * @category Media
 */
export interface DocumentMeta {
  title: string;
  pageCount: number;
  sections: {
    heading: string;
    /** Hierarchical path, `A > B > C`. */
    path: string;
    origin: SectionOrigin;
    startLine: number;
    endLine: number;
    pageStart: number;
    pageEnd: number;
  }[];
  pages: {
    /** 1-based. */
    page: number;
    startLine: number;
    endLine: number;
    /** Extracted characters; 0 for a scanned page. */
    chars: number;
    imageObjects: number;
    pathObjects: number;
    taggedTables: number;
    taggedFigures: number;
    /** Root of the page's render, present for every page within the render bound. */
    render?: Descriptor;
  }[];
  figures: {
    page: number;
    index: number;
    /** PDF user-space points, `[x0, y0, x1, y1]`. */
    bbox: [number, number, number, number];
    caption?: string;
    root: Descriptor;
  }[];
  /** Tagged tables emitted into the markdown as pipe tables. */
  tables: { page: number; startLine: number; endLine: number }[];
  /** What derived this document — so a replay under other settings sees the difference. */
  derive: {
    profile: 'pdf.v1';
    pdfium: string;
    dpi: number;
    maxSide: number;
    maxPixels: number;
    format: 'image/png';
    renderedPages: number;
    maxFigures: number;
    maxTextPages: number;
    tagged: boolean;
    structCoverage: number;
    /** A data cap bit (pages, figures, text pages). Never a timeout: a timeout publishes nothing. */
    truncated: boolean;
  };
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isDescriptor = (v: unknown): v is Descriptor =>
  isObj(v) && isStr(v.mediaType) && isStr(v.digest) && isInt(v.size);

/**
 * Narrow parsed JSON to a {@link DocumentMeta}, or refuse it. Never throws:
 * a sidecar arrives as bytes from a store, and a malformed one is a normal
 * answer, not a fault.
 *
 * @category Media
 */
export function asDocumentMeta(json: unknown): DocumentMeta | null {
  if (!isObj(json)) return null;
  const { title, pageCount, sections, pages, figures, tables, derive } = json;
  if (!isStr(title) || !isInt(pageCount)) return null;
  if (!Array.isArray(sections) || !Array.isArray(pages) || !Array.isArray(figures) || !Array.isArray(tables)) return null;
  const sectionOk = (s: unknown): boolean =>
    isObj(s) && isStr(s.heading) && isStr(s.path) &&
    (s.origin === 'struct' || s.origin === 'bookmark' || s.origin === 'heuristic') &&
    isInt(s.startLine) && isInt(s.endLine) && isInt(s.pageStart) && isInt(s.pageEnd);
  const pageOk = (p: unknown): boolean =>
    isObj(p) && isInt(p.page) && isInt(p.startLine) && isInt(p.endLine) && isInt(p.chars) &&
    isInt(p.imageObjects) && isInt(p.pathObjects) && isInt(p.taggedTables) && isInt(p.taggedFigures) &&
    (p.render === undefined || isDescriptor(p.render));
  const figureOk = (f: unknown): boolean =>
    isObj(f) && isInt(f.page) && isInt(f.index) && Array.isArray(f.bbox) && f.bbox.length === 4 &&
    f.bbox.every(isNum) && (f.caption === undefined || isStr(f.caption)) && isDescriptor(f.root);
  const tableOk = (t: unknown): boolean => isObj(t) && isInt(t.page) && isInt(t.startLine) && isInt(t.endLine);
  const deriveOk = (d: unknown): boolean =>
    isObj(d) && d.profile === 'pdf.v1' && isStr(d.pdfium) && isNum(d.dpi) && isInt(d.maxSide) && isInt(d.maxPixels) &&
    d.format === 'image/png' && isInt(d.renderedPages) && isInt(d.maxFigures) && isInt(d.maxTextPages) &&
    typeof d.tagged === 'boolean' && isNum(d.structCoverage) && typeof d.truncated === 'boolean';
  if (!sections.every(sectionOk) || !pages.every(pageOk) || !figures.every(figureOk) || !tables.every(tableOk) || !deriveOk(derive)) return null;
  return json as unknown as DocumentMeta;
}

/**
 * The pages a line span touches, by the sidecar's page map. A span past the
 * map — lines the extractor emitted after the last page's text — belongs to
 * the last page.
 *
 * @category Media
 */
export function pagesOf(meta: DocumentMeta, startLine: number, endLine: number): { pageStart: number; pageEnd: number } {
  return pagesOfSpan(meta.pages, startLine, endLine);
}

/** The same rule over a bare page map — what the layout uses before a sidecar exists. */
export function pagesOfSpan(
  pages: readonly { page: number; startLine: number; endLine: number }[],
  startLine: number,
  endLine: number,
): { pageStart: number; pageEnd: number } {
  const touched = pages.filter((p) => p.endLine >= startLine && p.startLine <= endLine);
  if (touched.length > 0) {
    return { pageStart: touched[0].page, pageEnd: touched[touched.length - 1].page };
  }
  const last = pages[pages.length - 1]?.page ?? 1;
  return { pageStart: last, pageEnd: last };
}
