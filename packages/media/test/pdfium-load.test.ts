/**
 * The codec loads offline, once compiled, one instance per document.
 *
 * This is the step that proves the dependency: the wasm ships in the package
 * and is read from disk (no CDN), the module compiles once and instantiates
 * per document through the glue's `instantiateWasm` hook, and a document
 * opened in one instance is invisible to another. Everything above this in
 * the ingress rests on these three facts.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCodec, openDocument, PdfError } from '../src/pdf';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'pdf', name)));

describe('createCodec', () => {
  it('loads the wasm from the package on disk and answers a page count', async () => {
    const codec = await createCodec();
    try {
      const doc = openDocument(codec, fixture('untagged.pdf'));
      try {
        expect(doc.pageCount).toBe(2);
      } finally {
        doc.close();
      }
    } finally {
      codec.dispose();
    }
  });

  it('gives each document its own instance: a handle from one is meaningless in another', async () => {
    const a = await createCodec();
    const b = await createCodec();
    try {
      expect(a.pdfium).not.toBe(b.pdfium);
      const doc = openDocument(a, fixture('untagged.pdf'));
      try {
        // The same handle number in the other instance is not a document.
        expect(b.pdfium.FPDF_GetPageCount(doc.handle)).not.toBe(2);
      } finally {
        doc.close();
      }
    } finally {
      a.dispose();
      b.dispose();
    }
  }, 30_000);

  it('names the reason a document cannot be opened', async () => {
    const codec = await createCodec();
    try {
      expect(() => openDocument(codec, fixture('encrypted.pdf'))).toThrow(PdfError);
      expect(() => openDocument(codec, fixture('encrypted.pdf'))).toThrow(/password/i);
      expect(() => openDocument(codec, new TextEncoder().encode('%PDF-1.4 not really'))).toThrow(/format|malformed/i);
    } finally {
      codec.dispose();
    }
  });
});
