/**
 * The evidence contract — the seam every provenance-bearing Ability programs
 * against, so its edges are asserted here rather than discovered by the second
 * consumer.
 *
 * The crossing-regions case is the reason `resolveCites` returns a list. A
 * supporting sentence routinely spans a paragraph break, a page break, or a
 * change of speaker; a citation naming only where it began would send a reader
 * to the wrong half of the evidence.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  resolveCites,
  assertWellFormedDocument,
  EvidenceDocumentError,
  type EvidenceDocument,
  type EvidenceRegion,
} from '../src/evidence';

/** `[0,10) p1¶1 · [10,20) p1¶2 · [20,30) p2¶1`, with a gap at [30,40). */
function paginated(text = 'x'.repeat(40)): EvidenceDocument {
  return {
    id: 'doc-1',
    text,
    regions: [
      { span: [0, 10], locator: { kind: 'page', page: 1, para: 1 } },
      { span: [10, 20], locator: { kind: 'page', page: 1, para: 2 } },
      { span: [20, 30], locator: { kind: 'page', page: 2, para: 1 } },
    ],
  };
}

describe('resolveCites', () => {
  it('returns every region a span touches, in document order', () => {
    // A sentence running from paragraph 2 into the next page.
    const cites = resolveCites(paginated(), [15, 25]);
    expect(cites).toEqual([
      { kind: 'page', page: 1, para: 2 },
      { kind: 'page', page: 2, para: 1 },
    ]);
  });

  it('spans wholly inside one region cite only that one', () => {
    expect(resolveCites(paginated(), [11, 19])).toEqual([
      { kind: 'page', page: 1, para: 2 },
    ]);
  });

  it('treats boundaries as half-open on both sides', () => {
    // [0,10) and [10,20) are adjacent, not overlapping. A span ending exactly
    // where the next region starts must not cite it.
    expect(resolveCites(paginated(), [0, 10])).toEqual([
      { kind: 'page', page: 1, para: 1 },
    ]);
    expect(resolveCites(paginated(), [10, 11])).toEqual([
      { kind: 'page', page: 1, para: 2 },
    ]);
  });

  it('returns nothing for a span in an unaddressable gap', () => {
    // Page furniture, silence between utterances — honest emptiness beats a
    // fabricated locator.
    expect(resolveCites(paginated(), [32, 38])).toEqual([]);
  });

  it('returns nothing for an empty or inverted span', () => {
    expect(resolveCites(paginated(), [5, 5])).toEqual([]);
    expect(resolveCites(paginated(), [9, 3])).toEqual([]);
  });

  it('addresses a transcript by speaker and timestamp', () => {
    const doc: EvidenceDocument = {
      id: 'hearing',
      text: 'a'.repeat(30),
      regions: [
        { span: [0, 15], locator: { kind: 'time', speaker: 'Counsel', tMs: 0 } },
        { span: [15, 30], locator: { kind: 'time', speaker: 'Witness', tMs: 8200 } },
      ],
    };
    // An answer that begins inside the question's utterance cites both — which
    // is exactly what a reader needs to see.
    expect(resolveCites(doc, [14, 20])).toEqual([
      { kind: 'time', speaker: 'Counsel', tMs: 0 },
      { kind: 'time', speaker: 'Witness', tMs: 8200 },
    ]);
  });
});

describe('assertWellFormedDocument', () => {
  it('accepts sorted, non-overlapping, in-bounds regions with gaps', () => {
    expect(() => assertWellFormedDocument(paginated())).not.toThrow();
  });

  it('accepts a document with no regions', () => {
    expect(() =>
      assertWellFormedDocument({ id: 'empty', text: 'abc', regions: [] }),
    ).not.toThrow();
  });

  it('rejects regions out of order', () => {
    // Ordering is what lets resolveCites stop early and return citations in
    // document order. Unsorted input yields quietly wrong citations.
    const doc = paginated();
    doc.regions = [doc.regions[1], doc.regions[0], doc.regions[2]];
    expect(() => assertWellFormedDocument(doc)).toThrow(EvidenceDocumentError);
  });

  it('rejects overlapping regions', () => {
    const doc = paginated();
    doc.regions[1] = { span: [5, 20], locator: doc.regions[1].locator };
    expect(() => assertWellFormedDocument(doc)).toThrow(/overlaps/);
  });

  it('rejects a span reaching past the text', () => {
    const doc = paginated('short');
    expect(() => assertWellFormedDocument(doc)).toThrow(/outside text/);
  });

  it('rejects an empty or inverted span', () => {
    const doc = paginated();
    doc.regions[0] = { span: [5, 5], locator: doc.regions[0].locator };
    expect(() => assertWellFormedDocument(doc)).toThrow(/empty or inverted/);
  });

  it('names the document in the error, since documents arrive in bulk', () => {
    const doc = paginated('short');
    expect(() => assertWellFormedDocument(doc)).toThrow(/"doc-1"/);
  });
});

describe('property: a well-formed document never mis-cites', () => {
  const regionsArb = fc
    .array(fc.integer({ min: 1, max: 8 }), { minLength: 1, maxLength: 12 })
    .map((lengths) => {
      // Build sorted, non-overlapping regions with occasional gaps.
      const regions: EvidenceRegion[] = [];
      let cursor = 0;
      lengths.forEach((len, i) => {
        cursor += i % 3 === 0 ? 1 : 0; // sprinkle gaps
        regions.push({
          span: [cursor, cursor + len],
          locator: { kind: 'page', page: 1, para: i + 1 },
        });
        cursor += len;
      });
      return { regions, length: cursor + 2 };
    });

  it('every returned cite belongs to a region that truly intersects', () => {
    fc.assert(
      fc.property(
        regionsArb,
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 0, max: 60 }),
        ({ regions, length }, a, b) => {
          const doc: EvidenceDocument = { id: 'p', text: 'x'.repeat(length), regions };
          assertWellFormedDocument(doc);
          const span: [number, number] = [Math.min(a, b), Math.max(a, b)];
          const cites = resolveCites(doc, span);

          // Recompute independently: a cite is legitimate iff its region
          // half-open-overlaps the span.
          const expected = regions
            .filter((r) => r.span[0] < span[1] && r.span[1] > span[0])
            .map((r) => r.locator);
          expect(cites).toEqual(span[1] > span[0] ? expected : []);
        },
      ),
      { numRuns: 30, seed: 42 },
    );
  });
});
