/**
 * One document in a real file store: four pages, a tagged table on page two
 * with a figure, a text-only page three, and a page four past the render
 * bound. Page roots are the PNG-header idiom — nothing in these tests decodes.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAttachmentStore } from '@lloyal-labs/media/node';
import { DOCUMENT_CONFIG_TYPE } from '@lloyal-labs/media';
import type { Attachment, AttachmentStore, DocumentMeta } from '@lloyal-labs/media';
import type { Reranker, Chunk } from '@lloyal-labs/rig';

export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

export const MARKDOWN = [
  '# Fixture Paper', '',                                                              // 1-2   page 1
  '## Introduction', '', 'Intro text alpha beta.', '',                                 // 3-6   page 1
  '## Results', '', '| Config | Cells |', '| --- | --- |', '| baseline | 803 |', '',   // 7-12  page 2
  '## Discussion', '', 'Closing words gamma.', '',                                     // 13-16 page 3
  '## Appendix', '', 'Chart described here.',                                          // 17-19 page 4 (+ line 20 blank from the trailing newline)
].join('\n') + '\n';

const DERIVE: DocumentMeta['derive'] = {
  profile: 'pdf.v1', pdfium: 'test', dpi: 150, maxSide: 2048, maxPixels: 4194304, format: 'image/png',
  renderedPages: 3, maxFigures: 16, maxTextPages: 400, tagged: true, structCoverage: 1, truncated: true,
};

export interface Fixture {
  store: FileAttachmentStore;
  doc: Attachment;
  image: Attachment;
  renders: Record<1 | 2 | 3, Attachment>;
  figure: Attachment;
  meta: DocumentMeta;
}

export function makeFixture(): Fixture {
  const store = new FileAttachmentStore(mkdtempSync(join(tmpdir(), 'documents-ability-')));
  const png = (tag: number): Attachment =>
    store.putAttachment({ representations: [store.putBlob(new Uint8Array([...PNG_BYTES, tag]), 'image/png')] });
  const image = png(100);
  const renders = { 1: png(1), 2: png(2), 3: png(3) } as const;
  const figure = png(9);
  const meta: DocumentMeta = {
    title: 'Fixture Paper',
    pageCount: 4,
    sections: [
      { heading: 'Fixture Paper', path: 'Fixture Paper', origin: 'struct', startLine: 1, endLine: 2, pageStart: 1, pageEnd: 1 },
      { heading: 'Introduction', path: 'Introduction', origin: 'struct', startLine: 3, endLine: 6, pageStart: 1, pageEnd: 1 },
      { heading: 'Results', path: 'Results', origin: 'struct', startLine: 7, endLine: 12, pageStart: 2, pageEnd: 2 },
      { heading: 'Discussion', path: 'Discussion', origin: 'struct', startLine: 13, endLine: 16, pageStart: 3, pageEnd: 3 },
      { heading: 'Appendix', path: 'Appendix', origin: 'struct', startLine: 17, endLine: 20, pageStart: 4, pageEnd: 4 },
    ],
    pages: [
      { page: 1, startLine: 1, endLine: 6, chars: 40, imageObjects: 0, pathObjects: 0, taggedTables: 0, taggedFigures: 0, render: renders[1] },
      { page: 2, startLine: 7, endLine: 12, chars: 30, imageObjects: 0, pathObjects: 30, taggedTables: 1, taggedFigures: 0, render: renders[2] },
      { page: 3, startLine: 13, endLine: 16, chars: 20, imageObjects: 0, pathObjects: 0, taggedTables: 0, taggedFigures: 0, render: renders[3] },
      { page: 4, startLine: 17, endLine: 20, chars: 21, imageObjects: 1, pathObjects: 0, taggedTables: 0, taggedFigures: 0 },
    ],
    figures: [{ page: 2, index: 0, bbox: [72, 300, 372, 500], caption: 'Figure 1. Cells per configuration.', root: figure }],
    tables: [{ page: 2, startLine: 9, endLine: 11 }],
    derive: DERIVE,
  };
  const doc = store.putAttachment({
    representations: [store.putBlob(new TextEncoder().encode(MARKDOWN), 'text/markdown')],
    source: store.putBlob(new TextEncoder().encode('%PDF-1.4 fixture'), 'application/pdf'),
    config: { bytes: new TextEncoder().encode(JSON.stringify(meta)), mediaType: DOCUMENT_CONFIG_TYPE },
  });
  return { store, doc, image, renders, figure, meta };
}

/** A second, one-page document in the same store. */
export function makeSecond(store: AttachmentStore, title = 'Second Report'): Attachment {
  const md = `# ${title}\n\n## Findings\n\nDelta epsilon zeta.\n`;
  const meta: DocumentMeta = {
    title, pageCount: 1,
    sections: [
      { heading: title, path: title, origin: 'heuristic', startLine: 1, endLine: 2, pageStart: 1, pageEnd: 1 },
      { heading: 'Findings', path: 'Findings', origin: 'heuristic', startLine: 3, endLine: 6, pageStart: 1, pageEnd: 1 },
    ],
    pages: [{ page: 1, startLine: 1, endLine: 6, chars: 30, imageObjects: 0, pathObjects: 0, taggedTables: 0, taggedFigures: 0 }],
    figures: [], tables: [], derive: { ...DERIVE, renderedPages: 0, tagged: false, structCoverage: 0, truncated: false },
  };
  return store.putAttachment({
    representations: [store.putBlob(new TextEncoder().encode(md), 'text/markdown')],
    config: { bytes: new TextEncoder().encode(JSON.stringify(meta)), mediaType: DOCUMENT_CONFIG_TYPE },
  });
}

/** Words stand in for tokens: fitting needs only a tokenizer. */
export const wordTokenize = async (text: string): Promise<number[]> =>
  text.split(/\s+/).filter(Boolean).map((_, i) => i + 1);

/** A reranker whose scorer admits everything with score 1 — the funnel's
 *  shape is under test here, not the cross-encoder. */
export function scoringReranker(): Reranker {
  return {
    tokenize: wordTokenize,
    tokenizeChunks: async (chunks: Chunk[]) => chunks,
    // The judge's verdict, shaped like the real one: log-odds, positive when
    // a query word occurs in the passage, negative when none does — so a
    // query the document never mentions is judged "no" everywhere.
    score(query: string, chunks: Chunk[]) {
      const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      return (async function* () {
        yield {
          filled: chunks.length, total: chunks.length,
          results: chunks.map((c) => ({
            file: c.resource, heading: c.heading, section: c.section, snippet: c.text,
            score: words.some((w) => c.text.toLowerCase().includes(w)) ? 1 : -1,
            startLine: c.startLine, endLine: c.endLine,
          })),
        };
      })();
    },
    scoreBatch: async () => [],
    dispose: () => {},
  } as unknown as Reranker;
}
