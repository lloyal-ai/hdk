/**
 * Page renders and figure crops: the archive, the projection facts, the tagged
 * structure, and the scanned page — against real fixtures.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { FileAttachmentStore } from '../src/node';
import { createDocumentIngress } from '../src/pdf';
import { normalizeImage } from '../src/image';
import { asDocumentMeta } from '../src/document';
import { RENDER_MAX_SIDE } from '../src/pdf';
import { DEFAULT_MAX_PIXELS } from '../src/image';
import { representationsOf } from '../src/attachment';
import { materialize } from '../src/ingress';
import type { DocumentMeta } from '../src/document';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'pdf', name)));
const freshStore = (): FileAttachmentStore => new FileAttachmentStore(mkdtempSync(join(tmpdir(), 'pdf-render-')));

async function ingest(name: string, opts: Parameters<typeof createDocumentIngress>[1] = {}) {
  const store = freshStore();
  const root = await createDocumentIngress(store, opts).ingest(fixture(name));
  const manifest = store.getManifest(root.digest)!;
  const meta = asDocumentMeta(JSON.parse(new TextDecoder().decode(store.get(manifest.config.digest)!)))!;
  const markdown = new TextDecoder().decode(store.get(representationsOf(manifest)[0].digest)!);
  return { store, root, meta, markdown };
}

describe('the archive', () => {
  it('renders every page within the bound as its own image root the projector can read, byte-stable under the normalizer', async () => {
    const { store, meta } = await ingest('tagged.pdf');
    expect(meta.pages.map((p) => !!p.render)).toEqual([true, true, true]);
    for (const p of meta.pages) {
      const prepared = materialize(store, [p.render!] as never);
      expect(prepared.bitmaps).toHaveLength(1);
      const png = prepared.bitmaps[0];
      const norm = await normalizeImage(png, {});
      expect(norm.derived).toBe(false);
      expect(norm.bytes).toBe(png);
      expect(norm.mime).toBe('image/png');
    }
    expect(meta.derive.renderedPages).toBe(3);
    expect(meta.derive.truncated).toBe(false);
  }, 90_000);

  it('records per-page facts: the image page and the table page carry objects, the text page does not', async () => {
    const { meta } = await ingest('tagged.pdf');
    const [p1, p2, p3] = meta.pages;
    expect(p1.chars).toBeGreaterThan(100);
    expect(p1.imageObjects).toBe(0);
    expect(p2.taggedTables + p2.pathObjects).toBeGreaterThan(0);
    expect(p3.imageObjects).toBeGreaterThan(0);
  }, 90_000);

  it('chooses graphics-bearing pages first under a page cap, marks the result truncated, and stays deterministic', async () => {
    const a = await ingest('tagged.pdf', { maxRenderedPages: 2 });
    const rendered = a.meta.pages.filter((p) => p.render).map((p) => p.page);
    // Page one always. Pages two (a tagged, rule-drawn table) and three (an
    // image) are both graphics-bearing, so the tie falls to page order and
    // the cap keeps page two; the text-only page would lose to either.
    expect(rendered).toEqual([1, 2]);
    expect(a.meta.derive.truncated).toBe(true);
    const b = await ingest('tagged.pdf', { maxRenderedPages: 2 });
    expect(b.root.digest).toBe(a.root.digest);
    const one = await ingest('tagged.pdf', { maxRenderedPages: 1 });
    expect(one.meta.pages.filter((p) => p.render).map((p) => p.page)).toEqual([1]);
  }, 120_000);
});

describe('the tagged path', () => {
  it('takes sections from the structure tree, emits the table as pipe rows, paths from bookmarks, and reports coverage', async () => {
    const { meta, markdown } = await ingest('tagged.pdf');
    expect(meta.derive.tagged).toBe(true);
    expect(meta.derive.structCoverage).toBeGreaterThanOrEqual(0.9);
    expect(markdown).toContain('# A Tagged Paper');
    expect(markdown).toMatch(/\n### Introduction\n|\n## Introduction\n/);
    expect(markdown).toContain('| Configuration | Cells | Seconds |');
    expect(markdown).toContain('| baseline | 803 | 4.2 |');
    expect(meta.tables).toHaveLength(1);
    const results = meta.sections.find((s) => s.heading === 'Results')!;
    expect(['struct', 'bookmark']).toContain(results.origin);
    expect(results.pageStart).toBe(2);
  }, 90_000);

  it('crops the figure with its caption and the crop is the green rectangle, not the page', async () => {
    const { store, meta } = await ingest('tagged.pdf');
    expect(meta.figures).toHaveLength(1);
    const fig = meta.figures[0];
    expect(fig.page).toBe(3);
    expect(fig.caption).toMatch(/^Figure 1\./);
    const png = materialize(store, [fig.root] as never).bitmaps[0];
    const stats = await sharp(Buffer.from(png)).stats();
    const [r, g, b] = stats.channels.map((c) => c.mean);
    // #0a7 is rgb(0, 170, 119): green dominant, red near zero.
    expect(g).toBeGreaterThan(120);
    expect(r).toBeLessThan(60);
    expect(b).toBeGreaterThan(60);
  }, 90_000);
});

describe('the scanned page', () => {
  it('says the page has no extractable text, counts zero chars, and still archives the render', async () => {
    const { meta, markdown } = await ingest('scanned.pdf');
    expect(markdown).toContain('*[page 1: no extractable text — scanned image]*');
    expect(meta.pages[0].chars).toBe(0);
    expect(meta.pages[0].imageObjects).toBe(1);
    expect(meta.pages[0].render).toBeTruthy();
  }, 60_000);
});

describe('the bounds on figures', () => {
  /** The crop's own record of its size: the derive annotations on its representation. */
  function cropSize(store: FileAttachmentStore, meta: DocumentMeta, i = 0): { width: number; height: number } {
    const manifest = store.getManifest(meta.figures[i].root.digest)!;
    const a = manifest.layers[0].annotations ?? {};
    return { width: Number(a['ai.lloyal.derive.width']), height: Number(a['ai.lloyal.derive.height']) };
  }

  it('an image painted far past the page is cropped to its visible part, under the same ceilings as a page', async () => {
    // A 1×1 red image into a 2000-pt square on a 100-pt page: the object's
    // bounds are 20× the page; only the page is visible.
    const { store, meta } = await ingest('clipped.pdf');
    expect(meta.pages[0].imageObjects).toBe(1);
    expect(meta.figures).toHaveLength(1);
    const [x0, y0, x1, y1] = meta.figures[0].bbox;
    expect([x0, y0]).toEqual([0, 0]);
    expect(x1).toBeCloseTo(100, 0);
    expect(y1).toBeCloseTo(100, 0);
    const { width, height } = cropSize(store, meta);
    expect(Math.max(width, height)).toBeLessThanOrEqual(RENDER_MAX_SIDE);
    expect(width * height).toBeLessThanOrEqual(DEFAULT_MAX_PIXELS);
    // The crop is the visible page, so it is no larger than the page render.
    const page = store.getManifest(meta.pages[0].render!.digest)!.layers[0].annotations ?? {};
    expect(width).toBeLessThanOrEqual(Number(page['ai.lloyal.derive.width']));
    const png = materialize(store, [meta.figures[0].root] as never).bitmaps[0];
    const [r, g] = (await sharp(Buffer.from(png)).stats()).channels.map((c) => c.mean);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(40);
  }, 90_000);

  it('an image inside a Form XObject is counted, placed on the page through the form matrices, and cropped', async () => {
    // A 2×2 green image in a form with /Matrix translate (10,10), drawn under
    // an outer translate (40,40): page space [50,50]–[150,150] on a 200-pt page.
    const { store, meta } = await ingest('form.pdf');
    expect(meta.pages[0].imageObjects).toBe(1);
    expect(meta.figures).toHaveLength(1);
    const [x0, y0, x1, y1] = meta.figures[0].bbox;
    expect(x0).toBeCloseTo(50, 0); expect(y0).toBeCloseTo(50, 0);
    expect(x1).toBeCloseTo(150, 0); expect(y1).toBeCloseTo(150, 0);
    const png = materialize(store, [meta.figures[0].root] as never).bitmaps[0];
    const [r, g, b] = (await sharp(Buffer.from(png)).stats()).channels.map((c) => c.mean);
    expect(g).toBeGreaterThan(120);
    expect(r).toBeLessThan(60);
    expect(b).toBeGreaterThan(60);
  }, 90_000);

  it('an image over the pixel ceiling is refused before anything renders — direct, and nested in a form alike', async () => {
    await expect(ingest('bigimage.pdf', { maxRenderedPages: 0 })).rejects.toThrow(/pixel ceiling/);
    await expect(ingest('bigform.pdf', { maxRenderedPages: 0 })).rejects.toThrow(/pixel ceiling/);
  }, 90_000);
});

