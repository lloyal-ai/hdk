/**
 * The document ingress against real fixtures: the shape it commits, identity,
 * the bounds, and that nothing is written on abort or timeout.
 *
 * @category Testing
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAttachmentStore } from '../src/node';
import { createDocumentIngress, MAX_DOCUMENT_BYTES, PdfError } from '../src/pdf';
import { DOCUMENT_CONFIG_TYPE, asDocumentMeta } from '../src/document';
import { representationsOf, sourceOf } from '../src/attachment';
import { materialize } from '../src/ingress';
import type { DocumentMeta } from '../src/document';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'pdf', name)));
const freshStore = (): FileAttachmentStore => new FileAttachmentStore(mkdtempSync(join(tmpdir(), 'pdf-ingress-')));

/** The committed sidecar of a document root. */
function metaOf(store: FileAttachmentStore, digest: string): DocumentMeta {
  const manifest = store.getManifest(digest)!;
  expect(manifest.config.mediaType).toBe(DOCUMENT_CONFIG_TYPE);
  const meta = asDocumentMeta(JSON.parse(new TextDecoder().decode(store.get(manifest.config.digest)!)));
  if (!meta) throw new Error('sidecar did not validate');
  return meta;
}

describe('createDocumentIngress — the shape', () => {
  it('commits one text/markdown representation, the PDF as source, and the sidecar as config', async () => {
    const store = freshStore();
    const root = await createDocumentIngress(store).ingest(fixture('untagged.pdf'));
    const manifest = store.getManifest(root.digest)!;
    const reps = representationsOf(manifest);
    expect(reps).toHaveLength(1);
    expect(reps[0].mediaType).toBe('text/markdown');
    expect(sourceOf(manifest)?.mediaType).toBe('application/pdf');
    const meta = metaOf(store, root.digest);
    expect(meta.pageCount).toBe(2);
    expect(meta.title).toBe('An Untagged Report');
    // A document materializes to no bitmaps: its text is for retrieval, never the projector.
    expect(materialize(store, [root]).bitmaps).toEqual([]);
  }, 60_000);

  it('reads headings by size on an untagged page and maps sections to pages', async () => {
    const store = freshStore();
    const root = await createDocumentIngress(store).ingest(fixture('untagged.pdf'));
    const meta = metaOf(store, root.digest);
    const md = new TextDecoder().decode(store.get(representationsOf(store.getManifest(root.digest)!)[0].digest)!);
    expect(md).toContain('# An Untagged Report');
    expect(md).toContain('\n## First Section\n');
    expect(md).toContain('\n## Second Section\n');
    expect(md).toContain('Body text line one of the first section, set in the body size. Body text line two of the first section continues the paragraph.');
    const first = meta.sections.find((s) => s.heading === 'First Section')!;
    expect(first.origin).toBe('heuristic');
    expect([first.pageStart, first.pageEnd]).toEqual([1, 1]);
    expect(meta.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(meta.pages[1].chars).toBeGreaterThan(0);
  }, 60_000);

  it('yields the same root for the same bytes, twice, in two stores', async () => {
    const a = await createDocumentIngress(freshStore()).ingest(fixture('untagged.pdf'));
    const b = await createDocumentIngress(freshStore()).ingest(fixture('untagged.pdf'));
    expect(a.digest).toBe(b.digest);
  }, 60_000);
});

describe('createDocumentIngress — text at size one under a scaled matrix', () => {
  it('measures size and spacing from the advance boxes, so words stay whole and the title is the big line', async () => {
    // PDFium reports font size 1 for every glyph of matrix.pdf; a gap rule
    // scaled by that size calls every glyph gap a space. The loose box carries
    // the real advance and em height.
    const store = freshStore();
    const root = await createDocumentIngress(store).ingest(fixture('matrix.pdf'));
    const meta = metaOf(store, root.digest);
    expect(meta.title).toBe('Scaled Title Line');
    const md = new TextDecoder().decode(store.get(representationsOf(store.getManifest(root.digest)!)[0].digest)!);
    expect(md).toContain('# Scaled Title Line');
    expect(md).toContain('Body text set at size one under a scaled matrix. Second line of body text with several words.');
    expect(md).not.toMatch(/B o d y/);
  }, 60_000);
});

describe('createDocumentIngress — the bounds', () => {
  it('refuses a document over the byte ceiling before touching the codec', async () => {
    const store = freshStore();
    const big = new Uint8Array(MAX_DOCUMENT_BYTES + 1);
    big.set(new TextEncoder().encode('%PDF-1.4'));
    await expect(createDocumentIngress(store).ingest(big)).rejects.toThrow(/ceiling/);
  });

  it('names a password-protected document and a malformed one', async () => {
    const store = freshStore();
    await expect(createDocumentIngress(store).ingest(fixture('encrypted.pdf'))).rejects.toThrow(/password/i);
    await expect(createDocumentIngress(store).ingest(new TextEncoder().encode('%PDF-1.4 not really'))).rejects.toThrow(PdfError);
  });

  it('commits nothing when the caller gives up while the document is being read', async () => {
    const store = freshStore();
    const putBlob = vi.spyOn(store, 'putBlob');
    const putAttachment = vi.spyOn(store, 'putAttachment');
    const ctrl = new AbortController();
    const pending = createDocumentIngress(store).ingest(fixture('tagged.pdf'), ctrl.signal);
    // The ingress yields to the loop between pages; the abort lands there.
    setImmediate(() => ctrl.abort());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(putBlob).not.toHaveBeenCalled();
    expect(putAttachment).not.toHaveBeenCalled();
  }, 60_000);

  it('publishes nothing when the time bound bites, and says it timed out', async () => {
    const store = freshStore();
    const putAttachment = vi.spyOn(store, 'putAttachment');
    await expect(createDocumentIngress(store, { timeoutMs: 1 }).ingest(fixture('tagged.pdf')))
      .rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(putAttachment).not.toHaveBeenCalled();
  }, 60_000);

  it('serves five concurrent ingests of one document through the shared gate to one root', async () => {
    const store = freshStore();
    const ingress = createDocumentIngress(store);
    const roots = await Promise.all(Array.from({ length: 5 }, () => ingress.ingest(fixture('untagged.pdf'))));
    expect(new Set(roots.map((r) => r.digest)).size).toBe(1);
  }, 120_000);
});
