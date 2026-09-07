/**
 * @file The PDF codec at its seam: PDFium as WebAssembly, one instance per
 * document, everything bounded.
 *
 * Why WASM and not a native build: a hostile PDF that traps a wasm instance
 * takes that instance down, not the process the resident model lives in; and
 * one artifact serves every platform the runtime ships for. The codec is an
 * OPTIONAL peer like `sharp`, required at call time, so a harness that never
 * accepts a document never loads it.
 *
 * Ownership is the whole design here. The module is compiled once per process
 * (that is the expensive step); each document gets its OWN instance from that
 * compiled module, created when its ingest starts and discarded when it ends.
 * Nothing is shared between concurrent ingests, so there is no replacement
 * rule, no heap threshold and no owner to hand over: a trap kills only its own
 * document, and the shared permit gate bounds how many instances exist at once.
 *
 * Isolation is cooperative on the main thread: every FPDF call is synchronous.
 * A Worker over a built entry, with `terminate()` as the hard bound, is the
 * named upgrade path — not runnable from `src/*.ts` on Node 24 today.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import type { Attachment, Descriptor } from './attachment';
import { DERIVE_PREFIX } from './attachment';
import type { AttachmentStore } from './store';
import type { ContentIngress } from './ingress';
import { DOCUMENT_CONFIG_TYPE } from './document';
import type { DocumentMeta } from './document';
import { gate, abortError } from './gate';
import { DEFAULT_MAX_PIXELS, MAX_INPUT_PIXELS } from './image';
import { layoutDocument } from './pdf-layout';
import type { Bookmark, LayoutResult, PageChar, PageFacts, PageImage, PageStruct } from './pdf-layout';

/** The failure a caller can name: which document, and why PDFium refused it. */
export class PdfError extends Error {
  readonly name = 'PdfError';
}

/** PDFium's `FPDF_GetLastError` codes, in its words. */
const LOAD_ERRORS: Record<number, string> = {
  1: 'unknown error',
  2: 'file cannot be opened',
  3: 'malformed: not a PDF or a corrupt one',
  4: 'password protected',
  5: 'unsupported security scheme',
  6: 'page not found or content error',
};

/** One compiled module per process — the expensive step, paid once. */
let compiled: Promise<WebAssembly.Module> | null = null;

function compileOnce(): Promise<WebAssembly.Module> {
  compiled ??= (async () => {
    // Required at call time, not imported at module load: the codec is an
    // optional peer, and a harness that never accepts a document should not
    // pay 4.6 MB of wasm. The message names the package because the failure is
    // a missing install, not a bad document.
    let wasmPath: string;
    try {
      wasmPath = require.resolve('@embedpdf/pdfium/pdfium.wasm');
    } catch {
      throw new Error(
        'createCodec: `@embedpdf/pdfium` is not installed. Add it to the harness ' +
          'that accepts document uploads (npm i @embedpdf/pdfium).',
      );
    }
    return WebAssembly.compile(readFileSync(wasmPath));
  })();
  return compiled;
}

/**
 * A live codec: one wasm instance, owned by one document's ingest.
 *
 * @category Media
 */
export interface Codec {
  /** The wrapped module: FPDF calls as methods, plus `pdfium` for memory. */
  readonly pdfium: WrappedPdfiumModule;
  /** Reserve `size` bytes on the wasm heap; `free` them with {@link Codec.free}. */
  malloc(size: number): number;
  free(ptr: number): void;
  /** Drop the instance. Idempotent. Every handle from it is dead afterwards. */
  dispose(): void;
}

/**
 * Instantiate the compiled module for one document.
 *
 * @category Media
 */
export async function createCodec(): Promise<Codec> {
  const module = await compileOnce();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { init } = require('@embedpdf/pdfium') as typeof import('@embedpdf/pdfium');
  const wrapped = await init({
    // The glue honours this Emscripten hook: instantiate our compiled module
    // instead of fetching and compiling the wasm again. Returning `{}` tells the
    // glue the instantiation is asynchronous and will arrive via the callback.
    instantiateWasm(imports, onInstantiated) {
      WebAssembly.instantiate(module, imports).then((instance) => onInstantiated(instance));
      return {};
    },
  });
  wrapped.PDFiumExt_Init();

  let disposed = false;
  return {
    pdfium: wrapped,
    malloc(size: number): number {
      const ptr = wrapped.pdfium.wasmExports.malloc(size);
      if (ptr === 0) throw new PdfError(`codec: could not reserve ${size} bytes on the wasm heap`);
      return ptr;
    },
    free(ptr: number): void {
      wrapped.pdfium.wasmExports.free(ptr);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Nothing to call: an instance with no references is collected, heap and
      // all. Per-document lifetime IS the memory bound.
    },
  };
}

/**
 * An open PDF: its handle in one codec instance, and the heap it occupies.
 *
 * @category Media
 */
export interface OpenDocument {
  readonly handle: number;
  readonly pageCount: number;
  /** Release the document and the bytes copied onto the heap. Idempotent. */
  close(): void;
}

/**
 * Open a PDF from bytes in `codec`. The bytes are copied onto the wasm heap
 * and stay there until {@link OpenDocument.close}: PDFium reads lazily.
 *
 * @throws {PdfError} naming PDFium's reason — password, malformed, unsupported.
 *
 * @category Media
 */
export function openDocument(codec: Codec, bytes: Uint8Array): OpenDocument {
  const { pdfium } = codec;
  const ptr = codec.malloc(bytes.byteLength);
  pdfium.pdfium.HEAPU8.set(bytes, ptr);
  const handle = pdfium.FPDF_LoadMemDocument(ptr, bytes.byteLength, '');
  if (handle === 0) {
    codec.free(ptr);
    const code = pdfium.FPDF_GetLastError();
    throw new PdfError(`openDocument: ${LOAD_ERRORS[code] ?? `PDFium error ${code}`}`);
  }
  let closed = false;
  return {
    handle,
    pageCount: pdfium.FPDF_GetPageCount(handle),
    close(): void {
      if (closed) return;
      closed = true;
      pdfium.FPDF_CloseDocument(handle);
      codec.free(ptr);
    },
  };
}

// ── bounds ───────────────────────────────────────────────────────

/** Largest PDF admitted, refused before a byte reaches the wasm heap. */
export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
/** Time one document may take, end to end. A failure bound, never a coverage knob: past it nothing is published. */
export const DOCUMENT_TIMEOUT_MS = 120_000;
/** Pages rendered and archived; the rest are text only. Graphics-bearing pages are chosen first. */
export const MAX_RENDERED_PAGES = 200;
/** Pages whose text is extracted; past it the markdown says so. */
export const MAX_TEXT_PAGES = 400;
/** Figure crops committed per document. */
export const MAX_FIGURES = 16;
/** The render profile: what the derive annotations name. */
export const RENDER_PROFILE = 'pdf.v1';
export const RENDER_DPI = 150;
export const RENDER_MAX_SIDE = 2048;
/** A page is "graphics-bearing" at this many path objects — a chart, a rule-drawn table. */
const GRAPHICS_PATH_FLOOR = 20;
const MIN_FIGURE_SIDE_PX = 64;
const MIN_FIGURE_AREA_RATIO = 0.02;

// PDFium constants (fpdfview.h, fpdf_edit.h, fpdf_progressive.h).
const PAGEOBJ_PATH = 2;
const PAGEOBJ_IMAGE = 3;
const PAGEOBJ_FORM = 5;
/** How deep a walk follows Form XObjects nested in Form XObjects. */
const MAX_FORM_DEPTH = 8;
/** How many page objects one page's walk will visit, forms included. */
const MAX_WALKED_OBJECTS = 20_000;

/** A PDF matrix `[a b c d e f]`: (x, y) ↦ (a·x + c·y + e, b·x + d·y + f). */
type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
/** `outer ∘ inner`: apply `inner` first, then `outer`. */
function compose(outer: Matrix, inner: Matrix): Matrix {
  const [a, b, c, d, e, f] = outer; const [a2, b2, c2, d2, e2, f2] = inner;
  return [a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2, a * e2 + c * f2 + e, b * e2 + d * f2 + f];
}
/** The axis-aligned bounds of a rectangle after a matrix. */
function transformRect(m: Matrix, [x0, y0, x1, y1]: PageImage['bbox']): PageImage['bbox'] {
  const xs: number[] = []; const ys: number[] = [];
  for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]] as const) {
    xs.push(m[0] * x + m[2] * y + m[4]); ys.push(m[1] * x + m[3] * y + m[5]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
/** The part of `r` inside the page, or null when nothing of it is. */
function clipToPage(r: PageImage['bbox'], width: number, height: number): PageImage['bbox'] | null {
  const c: PageImage['bbox'] = [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(width, r[2]), Math.min(height, r[3])];
  return c[2] > c[0] && c[3] > c[1] ? c : null;
}
const BITMAP_BGRA = 4;
const FLAG_ANNOT = 0x01;
const FLAG_REVERSE_BYTE_ORDER = 0x10;
// fpdf_progressive.h: READY 0, TOBECONTINUED 1, DONE 2, FAILED 3.
const RENDER_TOBECONTINUED = 1;
const RENDER_DONE = 2;

/** The failure the route can map: ETIMEDOUT names the class, the message the document. */
function timeoutError(ms: number): Error {
  const e = new PdfError(`createDocumentIngress: document exceeded ${ms}ms`);
  (e as Error & { code: string }).code = 'ETIMEDOUT';
  return e;
}

// ── reading strings and structs off the heap ─────────────────────

/** The two-call pattern PDFium uses for UTF-16 strings: length, then fill. */
function utf16(codec: Codec, call: (buf: number, len: number) => number): string {
  const { pdfium } = codec;
  const len = call(0, 0);
  if (len <= 2) return '';
  const buf = codec.malloc(len);
  try {
    call(buf, len);
    return pdfium.pdfium.UTF16ToString(buf);
  } finally {
    codec.free(buf);
  }
}

// ── page facts ───────────────────────────────────────────────────

function readStruct(codec: Codec, page: number): { struct: PageStruct; altByMcid: Map<number, string> } | undefined {
  const { pdfium } = codec;
  const tree = pdfium.FPDF_StructTree_GetForPage(page);
  if (!tree) return undefined;
  const roleByMcid = new Map<number, string>();
  const altByMcid = new Map<number, string>();
  const tables: PageStruct['tables'] = [];
  let figures = 0;
  try {
    const typeOf = (el: number): string => utf16(codec, (b, l) => pdfium.FPDF_StructElement_GetType(el, b, l));
    const ownMcids = (el: number): number[] => {
      const n = pdfium.FPDF_StructElement_GetMarkedContentIdCount(el);
      const ids: number[] = [];
      for (let i = 0; i < n; i++) {
        const id = pdfium.FPDF_StructElement_GetMarkedContentIdAtIndex(el, i);
        if (id >= 0) ids.push(id);
      }
      if (ids.length === 0) {
        const one = pdfium.FPDF_StructElement_GetMarkedContentID(el);
        if (one >= 0) ids.push(one);
      }
      return ids;
    };
    const children = (el: number): number[] => {
      const n = pdfium.FPDF_StructElement_CountChildren(el);
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        const c = pdfium.FPDF_StructElement_GetChildAtIndex(el, i);
        if (c) out.push(c);
      }
      return out;
    };
    const descendantMcids = (el: number): number[] => [...ownMcids(el), ...children(el).flatMap(descendantMcids)];
    // Producers wrap marked content in structural wrappers (`NonStruct`, `Span`,
    // `Div`, …) that carry no meaning of their own: a wrapper's content takes the
    // role of the nearest semantic ancestor, or a heading under `H1 > NonStruct`
    // would read as body text.
    const TRANSPARENT = new Set(['NonStruct', 'Span', 'Div', 'Sect', 'Part', 'Art', 'Document', 'Link', 'Private']);
    const readTable = (table: number): PageStruct['tables'][number] => {
      const rows: { cells: { mcids: number[] }[] }[] = [];
      const visitRows = (el: number): void => {
        for (const c of children(el)) {
          const t = typeOf(c);
          if (t === 'TR') {
            const cells = children(c).filter((k) => { const kt = typeOf(k); return kt === 'TD' || kt === 'TH'; })
              .map((k) => ({ mcids: descendantMcids(k) }));
            rows.push({ cells });
          } else if (t !== 'Caption') visitRows(c);
        }
      };
      visitRows(table);
      // The table's content is its cells; a caption or a border path is not.
      return { mcids: rows.flatMap((r) => r.cells.flatMap((c) => c.mcids)), rows };
    };
    const visit = (el: number, cell: string | null, inherited: string | null): void => {
      const type = typeOf(el);
      const semantic = TRANSPARENT.has(type) ? inherited : type;
      const effective = cell ?? semantic ?? type;
      for (const m of ownMcids(el)) roleByMcid.set(m, effective);
      if (type === 'Figure') {
        figures++;
        const alt = utf16(codec, (b, l) => pdfium.FPDF_StructElement_GetAltText(el, b, l));
        if (alt) for (const m of descendantMcids(el)) altByMcid.set(m, alt);
      }
      if (type === 'Table') tables.push(readTable(el));
      const nextCell = type === 'TD' || type === 'TH' ? type : cell;
      for (const c of children(el)) visit(c, nextCell, semantic);
    };
    const n = pdfium.FPDF_StructTree_CountChildren(tree);
    for (let i = 0; i < n; i++) {
      const c = pdfium.FPDF_StructTree_GetChildAtIndex(tree, i);
      if (c) visit(c, null, null);
    }
  } finally {
    pdfium.FPDF_StructTree_Close(tree);
  }
  return { struct: { roleByMcid, tables, figures }, altByMcid };
}

/** Everything the layout needs about one page, read in one pass over the codec. */
function readPage(codec: Codec, doc: OpenDocument, index: number, opts: { text: boolean }): PageFacts {
  const { pdfium } = codec;
  const page = pdfium.FPDF_LoadPage(doc.handle, index);
  if (!page) throw new PdfError(`readPage: page ${index + 1} cannot be loaded`);
  const scratch = codec.malloc(96);
  try {
    const width = pdfium.FPDF_GetPageWidthF(page);
    const height = pdfium.FPDF_GetPageHeightF(page);
    const read = readStruct(codec, page);

    // Objects: image bounds (and a decompression-bomb check on their pixel size
    // before anything could decode them), and the path count. The walk follows
    // Form XObjects — rendering will decode what they hold, so the check and
    // the counts must see it too — with each child's bounds carried into page
    // space through the form matrices, and clipped to the page: an object may
    // extend far past the page and the renderer clips it, so the visible part
    // is the figure.
    const images: PageImage[] = [];
    let pathObjects = 0;
    let walked = 0;
    const matrixBuf = codec.malloc(24);
    const walk = (obj: number, depth: number, m: Matrix): void => {
      if (++walked > MAX_WALKED_OBJECTS) return;
      const type = pdfium.FPDFPageObj_GetType(obj);
      if (type === PAGEOBJ_PATH) { pathObjects++; return; }
      if (type === PAGEOBJ_FORM) {
        if (depth >= MAX_FORM_DEPTH) return;
        let fm: Matrix = IDENTITY;
        if (pdfium.FPDFPageObj_GetMatrix(obj, matrixBuf)) {
          fm = [0, 1, 2, 3, 4, 5].map((k) => pdfium.pdfium.getValue(matrixBuf + k * 4, 'float')) as Matrix;
        }
        const inner = compose(m, fm);
        const n = pdfium.FPDFFormObj_CountObjects(obj);
        for (let k = 0; k < n; k++) walk(pdfium.FPDFFormObj_GetObject(obj, k), depth + 1, inner);
        return;
      }
      if (type !== PAGEOBJ_IMAGE) return;
      if (pdfium.FPDFImageObj_GetImagePixelSize(obj, scratch, scratch + 4)) {
        const w = pdfium.pdfium.getValue(scratch, 'i32');
        const h = pdfium.pdfium.getValue(scratch + 4, 'i32');
        if (w * h > MAX_INPUT_PIXELS) {
          throw new PdfError(`readPage: page ${index + 1} embeds a ${w}×${h} image, over the ${MAX_INPUT_PIXELS}-pixel ceiling`);
        }
      }
      if (!pdfium.FPDFPageObj_GetBounds(obj, scratch, scratch + 4, scratch + 8, scratch + 12)) return;
      const own: PageImage['bbox'] = [
        pdfium.pdfium.getValue(scratch, 'float'), pdfium.pdfium.getValue(scratch + 4, 'float'),
        pdfium.pdfium.getValue(scratch + 8, 'float'), pdfium.pdfium.getValue(scratch + 12, 'float'),
      ];
      const bbox = clipToPage(depth === 0 ? own : transformRect(m, own), width, height);
      if (!bbox) return;
      const mcid = pdfium.FPDFPageObj_GetMarkedContentID(obj);
      const altText = mcid >= 0 ? read?.altByMcid.get(mcid) : undefined;
      images.push({ index: images.length, bbox, ...(altText ? { altText } : {}) });
    };
    try {
      const count = pdfium.FPDFPage_CountObjects(page);
      for (let i = 0; i < count; i++) walk(pdfium.FPDFPage_GetObject(page, i), 0, IDENTITY);
    } finally {
      codec.free(matrixBuf);
    }

    // Characters, with box, size, weight and marked-content id.
    const chars: PageChar[] = [];
    if (opts.text) {
      const tp = pdfium.FPDFText_LoadPage(page);
      if (tp) {
        try {
          const n = pdfium.FPDFText_CountChars(tp);
          const mcidOfObject = new Map<number, number>();
          for (let i = 0; i < n; i++) {
            const code = pdfium.FPDFText_GetUnicode(tp, i);
            const text = code > 0 ? String.fromCodePoint(code) : ' ';
            if (!pdfium.FPDFText_GetCharBox(tp, i, scratch, scratch + 8, scratch + 16, scratch + 24)) {
              chars.push({ text: '\n', x0: 0, y0: 0, x1: 0, y1: 0, size: 0, weight: 400, mcid: -1 });
              continue;
            }
            // Rotated text — a journal's margin stamp, a landscape label — is
            // not part of the page's reading flow; it would otherwise land as
            // one "line" per glyph. Horizontal means the glyph's up is the
            // page's up (a 180° flip counts as rotated too).
            const angle = pdfium.FPDFText_GetCharAngle(tp, i);
            if (Math.abs(Math.sin(angle)) > 0.1 || Math.cos(angle) < 0) continue;
            // The LOOSE box is the glyph's advance box in page units — its width
            // is the advance, so adjacent glyphs of one word abut and a word gap
            // is a real gap. The tight box is the fallback when PDFium has none.
            let left: number; let right: number; let bottom: number; let top: number;
            const loose = pdfium.FPDFText_GetLooseCharBox(tp, i, scratch + 32);
            if (loose) {
              // FS_RECTF: left, top, right, bottom.
              left = pdfium.pdfium.getValue(scratch + 32, 'float');
              top = pdfium.pdfium.getValue(scratch + 36, 'float');
              right = pdfium.pdfium.getValue(scratch + 40, 'float');
              bottom = pdfium.pdfium.getValue(scratch + 44, 'float');
            } else {
              left = pdfium.pdfium.getValue(scratch, 'double');
              right = pdfium.pdfium.getValue(scratch + 8, 'double');
              bottom = pdfium.pdfium.getValue(scratch + 16, 'double');
              top = pdfium.pdfium.getValue(scratch + 24, 'double');
            }
            // Size: the nominal font size × the text matrix's scale — the size
            // the page was set in, whatever font drew the glyph (an em box
            // varies by font: a math font's is taller than a text font's at
            // one size) and however the producer arrived at it (a font set at
            // size 1 under a ×9 matrix). The loose height is the fallback.
            let size = pdfium.FPDFText_GetFontSize(tp, i);
            if (pdfium.FPDFText_GetMatrix(tp, i, scratch + 64)) {
              // FS_MATRIX: a, b, c, d, e, f.
              const a = pdfium.pdfium.getValue(scratch + 64, 'float');
              const b = pdfium.pdfium.getValue(scratch + 68, 'float');
              const scale = Math.hypot(a, b);
              if (scale > 0) size *= scale;
            }
            if (!(size > 0) && loose) size = top - bottom;
            // The glyph origin's y is the baseline — the one thing a ligature
            // drawn from a fallback font (a smaller em box) still shares with
            // its neighbours, so lines group by it rather than by box edges.
            let baseline = bottom;
            if (pdfium.FPDFText_GetCharOrigin(tp, i, scratch + 48, scratch + 56)) {
              baseline = pdfium.pdfium.getValue(scratch + 56, 'double');
            }
            // A space PDFium synthesises between text runs has no box at all.
            // It is a separator, not a glyph: give it the previous glyph's
            // geometry so nothing downstream reads a zero-size box as a new
            // baseline or a size-one font.
            const last = chars[chars.length - 1];
            if (/\s/.test(text) && !(top - bottom > 0) && last && last.text !== '\n') {
              left = last.x1; right = last.x1; bottom = last.y0; top = last.y1; size = last.size;
              baseline = last.baseline ?? last.y0;
            }
            const obj = pdfium.FPDFText_GetTextObject(tp, i);
            let mcid = -1;
            if (obj) {
              const cached = mcidOfObject.get(obj);
              mcid = cached ?? pdfium.FPDFPageObj_GetMarkedContentID(obj);
              mcidOfObject.set(obj, mcid);
            }
            const weight = pdfium.FPDFText_GetFontWeight(tp, i);
            chars.push({
              text, x0: left, y0: bottom, x1: right, y1: top,
              size, baseline,
              weight: weight > 0 ? weight : 400,
              mcid,
            });
          }
        } finally {
          pdfium.FPDFText_ClosePage(tp);
        }
      }
    }

    return {
      page: index + 1, width, height, chars, images, pathObjects, textExtracted: opts.text,
      ...(read ? { struct: read.struct } : {}),
    };
  } finally {
    codec.free(scratch);
    pdfium.FPDF_ClosePage(page);
  }
}

function readBookmarks(codec: Codec, doc: OpenDocument): Bookmark[] {
  const { pdfium } = codec;
  const out: Bookmark[] = [];
  const visit = (first: number, level: number): void => {
    let bm = first;
    while (bm) {
      const title = utf16(codec, (b, l) => pdfium.FPDFBookmark_GetTitle(bm, b, l));
      const dest = pdfium.FPDFBookmark_GetDest(doc.handle, bm);
      const page = dest ? pdfium.FPDFDest_GetDestPageIndex(doc.handle, dest) + 1 : 0;
      out.push({ title, page, level });
      const child = pdfium.FPDFBookmark_GetFirstChild(doc.handle, bm);
      if (child) visit(child, level + 1);
      bm = pdfium.FPDFBookmark_GetNextSibling(doc.handle, bm);
    }
  };
  visit(pdfium.FPDFBookmark_GetFirstChild(doc.handle, 0), 0);
  return out;
}

// ── rendering ────────────────────────────────────────────────────

/** Pixel size for a page at `dpi`, held under the side and area ceilings. */
function renderSize(widthPt: number, heightPt: number, dpi: number): { width: number; height: number; scale: number } {
  const scale = fitScale(widthPt, heightPt, dpi / 72);
  return { width: Math.max(1, Math.floor(widthPt * scale)), height: Math.max(1, Math.floor(heightPt * scale)), scale };
}

/** `scale`, lowered until a `widthPt` × `heightPt` region fits the side and area ceilings. */
function fitScale(widthPt: number, heightPt: number, scale: number): number {
  const longest = Math.max(widthPt, heightPt) * scale;
  if (longest > RENDER_MAX_SIDE) scale *= RENDER_MAX_SIDE / longest;
  const area = widthPt * heightPt * scale * scale;
  if (area > DEFAULT_MAX_PIXELS) scale *= Math.sqrt(DEFAULT_MAX_PIXELS / area);
  return scale;
}

/** Copy a bitmap's RGBA rows off the heap (the stride may exceed the row). */
function bitmapPixels(codec: Codec, bmp: number, width: number, height: number): Uint8Array {
  const { pdfium } = codec;
  const buf = pdfium.FPDFBitmap_GetBuffer(bmp);
  const stride = pdfium.FPDFBitmap_GetStride(bmp);
  const row = width * 4;
  const out = new Uint8Array(row * height);
  const heap = pdfium.pdfium.HEAPU8;
  for (let y = 0; y < height; y++) out.set(heap.subarray(buf + y * stride, buf + y * stride + row), y * row);
  return out;
}

/** Render a whole page progressively, stopping at the deadline or an abort. */
function renderPageRgba(codec: Codec, page: number, width: number, height: number, stop: () => boolean): Uint8Array {
  const { pdfium } = codec;
  const bmp = pdfium.FPDFBitmap_CreateEx(width, height, BITMAP_BGRA, 0, 0);
  if (!bmp) throw new PdfError(`render: could not allocate a ${width}×${height} bitmap`);
  const pause = codec.malloc(12);
  const fn = pdfium.pdfium.addFunction(() => (stop() ? 1 : 0), 'ip');
  try {
    pdfium.FPDFBitmap_FillRect(bmp, 0, 0, width, height, 0xffffffff);
    pdfium.pdfium.setValue(pause, 1, 'i32');
    pdfium.pdfium.setValue(pause + 4, fn, 'i32');
    pdfium.pdfium.setValue(pause + 8, 0, 'i32');
    let status = pdfium.FPDF_RenderPageBitmap_Start(bmp, page, 0, 0, width, height, 0, FLAG_ANNOT | FLAG_REVERSE_BYTE_ORDER, pause);
    while (status === RENDER_TOBECONTINUED && !stop()) status = pdfium.FPDF_RenderPage_Continue(page, pause);
    pdfium.FPDF_RenderPage_Close(page);
    if (status !== RENDER_DONE) throw new PdfError(status === RENDER_TOBECONTINUED ? 'render: stopped' : 'render: PDFium failed');
    return bitmapPixels(codec, bmp, width, height);
  } finally {
    pdfium.pdfium.removeFunction(fn);
    codec.free(pause);
    pdfium.FPDFBitmap_Destroy(bmp);
  }
}

/** Render a region of a page — a figure's bounds — at `scale` pixels per point. */
function renderRegionRgba(codec: Codec, page: number, pageHeightPt: number, bbox: PageImage['bbox'], pageScale: number): { rgba: Uint8Array; width: number; height: number } {
  const { pdfium } = codec;
  const [x0, y0, x1, y1] = bbox;
  // The bounds were clipped to the page when read, so at the page's scale the
  // crop is never larger than the page render; the ceilings hold regardless.
  const scale = fitScale(x1 - x0, y1 - y0, pageScale);
  const width = Math.max(1, Math.round((x1 - x0) * scale));
  const height = Math.max(1, Math.round((y1 - y0) * scale));
  const bmp = pdfium.FPDFBitmap_CreateEx(width, height, BITMAP_BGRA, 0, 0);
  if (!bmp) throw new PdfError(`render: could not allocate a ${width}×${height} bitmap`);
  const matrix = codec.malloc(24);
  const clip = codec.malloc(16);
  try {
    pdfium.FPDFBitmap_FillRect(bmp, 0, 0, width, height, 0xffffffff);
    // Device space is top-left, y down; user space is bottom-left, y up. The
    // display transform already flips y, so the region's top edge lands at the
    // device origin when translated by the distance from the page top.
    const m = [scale, 0, 0, scale, -x0 * scale, -(pageHeightPt - y1) * scale];
    m.forEach((v, i) => pdfium.pdfium.setValue(matrix + i * 4, v, 'float'));
    [0, 0, width, height].forEach((v, i) => pdfium.pdfium.setValue(clip + i * 4, v, 'float'));
    pdfium.FPDF_RenderPageBitmapWithMatrix(bmp, page, matrix, clip, FLAG_ANNOT | FLAG_REVERSE_BYTE_ORDER);
    return { rgba: bitmapPixels(codec, bmp, width, height), width, height };
  } finally {
    codec.free(matrix);
    codec.free(clip);
    pdfium.FPDFBitmap_Destroy(bmp);
  }
}

/** RGBA pixels → PNG, through sharp with its defaults, which are deterministic for a fixed libvips. */
async function toPng(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sharp = require('sharp') as typeof import('sharp').default;
  const png = await sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width, height, channels: 4 } })
    .removeAlpha()
    .png()
    .toBuffer();
  return new Uint8Array(png);
}

/** Let the event loop breathe between pages: the socket, the model loop, an abort. */
const breathe = (): Promise<void> => new Promise((r) => setImmediate(r));

function codecVersion(): string {
  try {
    const entry = require.resolve('@embedpdf/pdfium');
    const pkg = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// ── the ingress ──────────────────────────────────────────────────

/**
 * What a host may size differently. Every default is the shipped bound above;
 * tests use small numbers to reach the caps with small fixtures.
 *
 * @category Media
 */
export interface DocumentOpts {
  maxRenderedPages?: number;
  maxTextPages?: number;
  maxFigures?: number;
  timeoutMs?: number;
  dpi?: number;
}

/**
 * The document ingress: a PDF in, a document attachment out.
 *
 * One permit of the shared gate for the whole document, one codec instance
 * for the whole document. Extraction and rendering complete in memory first;
 * the store is written only after the last check, so an abort or a timeout
 * commits nothing. Coverage — which pages are rendered, how many figures —
 * is a function of the input and the declared caps, never of time, so the
 * same bytes yield the same root on any machine.
 *
 * @category Media
 */
export function createDocumentIngress(store: AttachmentStore, opts: DocumentOpts = {}): ContentIngress {
  const maxRenderedPages = opts.maxRenderedPages ?? MAX_RENDERED_PAGES;
  const maxTextPages = opts.maxTextPages ?? MAX_TEXT_PAGES;
  const maxFigures = opts.maxFigures ?? MAX_FIGURES;
  const timeoutMs = opts.timeoutMs ?? DOCUMENT_TIMEOUT_MS;
  const dpi = opts.dpi ?? RENDER_DPI;
  const label = 'createDocumentIngress';

  return {
    async ingest(bytes: Uint8Array, signal?: AbortSignal): Promise<Attachment> {
      if (signal?.aborted) throw abortError(label);
      if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
        throw new PdfError(`${label}: document is ${bytes.byteLength} bytes, over the ${MAX_DOCUMENT_BYTES}-byte ceiling`);
      }
      const release = await gate.acquire(signal);
      try {
        const deadline = Date.now() + timeoutMs;
        const stop = (): boolean => Date.now() > deadline || !!signal?.aborted;
        const check = (): void => {
          if (signal?.aborted) throw abortError(label);
          if (Date.now() > deadline) throw timeoutError(timeoutMs);
        };

        const codec = await createCodec();
        try {
          const doc = openDocument(codec, bytes);
          try {
            const title = utf16(codec, (b, l) => codec.pdfium.FPDF_GetMetaText(doc.handle, 'Title', b, l)) || null;
            const bookmarks = readBookmarks(codec, doc);

            const pages: PageFacts[] = [];
            for (let i = 0; i < doc.pageCount; i++) {
              check();
              pages.push(readPage(codec, doc, i, { text: i < maxTextPages }));
              await breathe();
            }
            const layout = layoutDocument({
              title, pages, bookmarks, maxTextPages, dpi,
              minFigureSidePx: MIN_FIGURE_SIDE_PX, minFigureAreaRatio: MIN_FIGURE_AREA_RATIO,
            });

            // Which pages to archive under the cap: page one, then every
            // graphics-bearing page, then the rest — a deterministic order.
            const graphic = (p: LayoutResult['pages'][number]): boolean =>
              p.page === 1 || p.chars === 0 || p.imageObjects > 0 || p.pathObjects >= GRAPHICS_PATH_FLOOR || p.taggedTables > 0 || p.taggedFigures > 0;
            const order = [...layout.pages]
              .sort((a, b) => Number(graphic(b)) - Number(graphic(a)) || a.page - b.page)
              .slice(0, maxRenderedPages)
              .sort((a, b) => a.page - b.page);

            const renders = new Map<number, { png: Uint8Array; width: number; height: number }>();
            const crops: { figure: LayoutResult['figures'][number]; png: Uint8Array; width: number; height: number }[] = [];
            const figures = layout.figures.slice(0, maxFigures);
            for (const p of order) {
              check();
              const facts = pages[p.page - 1];
              const size = renderSize(facts.width, facts.height, dpi);
              const page = codec.pdfium.FPDF_LoadPage(doc.handle, p.page - 1);
              if (!page) throw new PdfError(`render: page ${p.page} cannot be loaded`);
              try {
                const rgba = renderPageRgba(codec, page, size.width, size.height, stop);
                check();
                renders.set(p.page, { png: await toPng(rgba, size.width, size.height), width: size.width, height: size.height });
                for (const f of figures.filter((x) => x.page === p.page)) {
                  check();
                  const region = renderRegionRgba(codec, page, facts.height, f.bbox, size.scale);
                  crops.push({ figure: f, png: await toPng(region.rgba, region.width, region.height), width: region.width, height: region.height });
                }
              } finally {
                codec.pdfium.FPDF_ClosePage(page);
              }
              await breathe();
            }
            // A figure on a page that fell outside the render cap is not cropped
            // either: crops come from rendered pages, so the archive is consistent.
            const truncated = layout.truncated || renders.size < doc.pageCount || layout.figures.length > figures.length;

            // The last check before the first write: from here nothing waits and
            // nothing aborts, so a document is committed whole or not at all.
            check();
            const source = store.putBlob(bytes, 'application/pdf');
            const derive = (page: number, width: number, height: number, extra: Record<string, string> = {}): Record<string, string> => ({
              [`${DERIVE_PREFIX}profile`]: RENDER_PROFILE,
              [`${DERIVE_PREFIX}page`]: String(page),
              [`${DERIVE_PREFIX}dpi`]: String(dpi),
              [`${DERIVE_PREFIX}width`]: String(width),
              [`${DERIVE_PREFIX}height`]: String(height),
              [`${DERIVE_PREFIX}format`]: 'image/png',
              [`${DERIVE_PREFIX}source`]: source.digest,
              ...extra,
            });
            const pageRoots = new Map<number, Descriptor>();
            for (const [page, r] of renders) {
              const rep = store.putBlob(r.png, 'image/png', derive(page, r.width, r.height));
              pageRoots.set(page, store.putAttachment({ representations: [rep] }));
            }
            const figureRoots: DocumentMeta['figures'] = crops.map((c) => {
              const rep = store.putBlob(c.png, 'image/png', derive(c.figure.page, c.width, c.height, { [`${DERIVE_PREFIX}bbox`]: c.figure.bbox.join(',') }));
              return { ...c.figure, root: store.putAttachment({ representations: [rep] }) };
            });
            const markdown = store.putBlob(new TextEncoder().encode(layout.markdown), 'text/markdown');
            const meta: DocumentMeta = {
              title: layout.title,
              pageCount: doc.pageCount,
              sections: layout.sections,
              pages: layout.pages.map((p) => { const render = pageRoots.get(p.page); return render ? { ...p, render } : p; }),
              figures: figureRoots,
              tables: layout.tables,
              derive: {
                profile: RENDER_PROFILE, pdfium: codecVersion(), dpi, maxSide: RENDER_MAX_SIDE, maxPixels: DEFAULT_MAX_PIXELS, format: 'image/png',
                renderedPages: renders.size, maxFigures, maxTextPages, tagged: layout.tagged, structCoverage: layout.structCoverage, truncated,
              },
            };
            return store.putAttachment({
              representations: [markdown],
              source,
              config: { bytes: new TextEncoder().encode(JSON.stringify(meta)), mediaType: DOCUMENT_CONFIG_TYPE },
            });
          } finally {
            doc.close();
          }
        } finally {
          codec.dispose();
        }
      } finally {
        release();
      }
    },
  };
}
