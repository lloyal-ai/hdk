/**
 * `loadDocuments` — from document attachments in the content store to the
 * resources and chunks the retrieval stack already understands. No codec, no
 * addon: a document root is a manifest whose config is the sidecar.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAttachmentStore } from '@lloyal-labs/media/node';
import { DOCUMENT_CONFIG_TYPE } from '@lloyal-labs/media';
import type { Attachment, DocumentMeta } from '@lloyal-labs/media';
import { loadDocuments } from '../src/resources/documents';

const MARKDOWN = ['# A paper', '', '## Intro', '', 'First line of the intro.', 'Second line of the intro.', '', '## Method', '', 'Method body.'].join('\n');

const meta = (title: string): DocumentMeta => ({
  title, pageCount: 2,
  sections: [
    { heading: title, path: title, origin: 'heuristic', startLine: 1, endLine: 2, pageStart: 1, pageEnd: 1 },
    { heading: 'Intro', path: 'Intro', origin: 'heuristic', startLine: 3, endLine: 7, pageStart: 1, pageEnd: 1 },
    { heading: 'Method', path: 'Method', origin: 'heuristic', startLine: 8, endLine: 10, pageStart: 2, pageEnd: 2 },
  ],
  pages: [
    { page: 1, startLine: 1, endLine: 7, chars: 60, imageObjects: 0, pathObjects: 0, taggedTables: 0, taggedFigures: 0 },
    { page: 2, startLine: 8, endLine: 10, chars: 12, imageObjects: 0, pathObjects: 0, taggedTables: 0, taggedFigures: 0 },
  ],
  figures: [], tables: [],
  derive: { profile: 'pdf.v1', pdfium: 'test', dpi: 150, maxSide: 2048, maxPixels: 4_194_304, format: 'image/png', renderedPages: 2, maxFigures: 16, maxTextPages: 400, tagged: false, structCoverage: 0, truncated: false },
});

function commitDocument(store: FileAttachmentStore, title: string, markdown = MARKDOWN): Attachment {
  const md = store.putBlob(new TextEncoder().encode(markdown), 'text/markdown');
  return store.putAttachment({
    representations: [md],
    config: { bytes: new TextEncoder().encode(JSON.stringify(meta(title))), mediaType: DOCUMENT_CONFIG_TYPE },
  });
}

describe('loadDocuments', () => {
  it('turns a document root into a resource and one chunk per section, with real lines and the section path', () => {
    const store = new FileAttachmentStore(mkdtempSync(join(tmpdir(), 'documents-')));
    const root = commitDocument(store, 'A paper');
    const [doc] = loadDocuments(store, [root]);
    expect(doc.attachment).toEqual(root);
    expect(doc.meta.title).toBe('A paper');
    expect(doc.resource).toEqual({ name: 'A paper', content: MARKDOWN });
    expect(doc.chunks.map((c) => [c.heading, c.section, c.startLine, c.endLine])).toEqual([
      ['A paper', 'A paper', 1, 2], ['Intro', 'Intro', 3, 7], ['Method', 'Method', 8, 10],
    ]);
    expect(doc.chunks[1].text).toBe('## Intro\n\nFirst line of the intro.\nSecond line of the intro.\n');
    expect(doc.chunks.every((c) => c.resource === 'A paper' && c.tokens.length === 0)).toBe(true);
  });

  it('skips roots that are not documents — an image root is legitimately something else', () => {
    const store = new FileAttachmentStore(mkdtempSync(join(tmpdir(), 'documents-')));
    const image = store.putAttachment({ representations: [store.putBlob(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]), 'image/png')] });
    const doc = commitDocument(store, 'Only one');
    expect(loadDocuments(store, [image, doc]).map((d) => d.meta.title)).toEqual(['Only one']);
  });

  it('dedupes resource names so two documents with one title stay addressable', () => {
    const store = new FileAttachmentStore(mkdtempSync(join(tmpdir(), 'documents-')));
    const a = commitDocument(store, 'Same');
    const b = commitDocument(store, 'Same', MARKDOWN + '\nextra');
    expect(loadDocuments(store, [a, b]).map((d) => d.resource.name)).toEqual(['Same', 'Same (2)']);
  });

  it('throws naming the digest when the markdown blob is missing or drifted', () => {
    const store = new FileAttachmentStore(mkdtempSync(join(tmpdir(), 'documents-')));
    const root = commitDocument(store, 'Drifted');
    const md = store.getManifest(root.digest)!.layers[0];
    const path = join((store as unknown as { _dir: string })._dir, 'blobs', 'sha256', md.digest.slice(7));
    require('node:fs').writeFileSync(path, 'tampered');
    expect(() => loadDocuments(store, [root])).toThrow(new RegExp(md.digest.slice(0, 19)));
  });
});
