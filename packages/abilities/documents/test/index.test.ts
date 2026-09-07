import { describe, it, expect } from 'vitest';
import { MANIFEST_TYPE } from '@lloyal-labs/media';
import type { Attachment } from '@lloyal-labs/media';
import { documentIndexer, documentId, pageCite } from '../src/documents-index';
import { makeFixture, makeSecond, wordTokenize } from './helpers/fixture';

describe('documentIndexer', () => {
  it('the same attachments give the same index, and a digest is fitted once', async () => {
    const { store, doc, image } = makeFixture();
    let calls = 0;
    const indexFor = documentIndexer(store, async (t) => { calls++; return wordTokenize(t); });
    const a = await indexFor([doc]);
    const b = await indexFor([doc]);
    expect(b).toBe(a);
    expect(a.documents).toHaveLength(1);
    expect(a.documents[0].id).toBe(documentId(doc));
    expect(a.chunks.length).toBeGreaterThan(0);
    expect(a.chunks.every((c) => c.resource === a.documents[0].id)).toBe(true);
    const fitted = calls;
    expect(fitted).toBeGreaterThan(0);
    // A different set — the image adds no document — builds a new index but re-tokenizes nothing.
    const c = await indexFor([image, doc]);
    expect(c).not.toBe(a);
    expect(c.documents.map((d) => d.id)).toEqual([documentId(doc)]);
    expect(calls).toBe(fitted);
    // The same root twice is one document.
    expect((await indexFor([doc, doc])).documents).toHaveLength(1);
  });

  it('a second document is searchable once it is available to the run, by id or title', async () => {
    const { store, doc } = makeFixture();
    const second = makeSecond(store);
    const indexFor = documentIndexer(store, wordTokenize);
    expect((await indexFor([doc])).documents).toHaveLength(1);
    const both = await indexFor([doc, second]);
    expect(both.documents.map((d) => d.meta.title)).toEqual(['Fixture Paper', 'Second Report']);
    expect(both.find('second report')?.id).toBe(documentId(second));
    expect(both.find(documentId(second))?.meta.title).toBe('Second Report');
    expect(both.find('nope')).toBeUndefined();
  });

  it('a root that is not in the store throws naming the digest, and the failure is not remembered', async () => {
    const { store, doc } = makeFixture();
    const indexFor = documentIndexer(store, wordTokenize);
    const gone = { digest: 'sha256:' + 'e'.repeat(64), mediaType: MANIFEST_TYPE, size: 9 } as Attachment;
    await expect(indexFor([doc, gone])).rejects.toThrow(/sha256:e{12}… is not in the content store/);
    // The good document still indexes on its own afterwards.
    expect((await indexFor([doc])).documents).toHaveLength(1);
  });

  it('handles and citations derive from the digest', () => {
    const { doc } = makeFixture();
    const id = documentId(doc);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(doc.digest).toContain(id);
    expect(pageCite(doc, 7)).toBe(`attachment://${id}/page/7`);
  });
});
