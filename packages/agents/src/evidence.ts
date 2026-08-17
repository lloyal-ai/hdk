/**
 * Evidence provenance types — where a claim came from, precisely enough to open.
 *
 * A chunk tells you which file and roughly which lines. That is enough to
 * retrieve, and not enough to cite: a paragraph can hold several assertions, and
 * a professional acting on one of them needs the span that supports it, not the
 * region that contains it. {@link EvidenceRegion} carries character offsets and a
 * domain-specific locator, so an assertion can point at the sentence and the
 * reader lands on the page.
 *
 * These live in `@lloyal-labs/lloyal-agents` for the reason {@link Chunk} does —
 * ability factories and harness contexts refer to the shape without depending on
 * rig's concrete loaders. The producers (loaders, OCR, transcript importers)
 * belong in rig; the contract belongs here. Abstract type in agents, concrete
 * factories in rig, the same split as `Source` and `Tool`.
 *
 * DELIBERATELY SERIALISABLE. An earlier draft modelled this as a callback —
 * `locator(offset) => Cite` — which cannot cross a manifest boundary, cannot be
 * persisted in an audit record, and cannot travel from a producing Ability to a
 * consuming one. Regions are data so that a document assembled by one Ability is
 * usable by another, and so an offset resolved today resolves the same way when
 * someone re-opens the record.
 *
 * @packageDocumentation
 * @category Contract
 */

/**
 * A human-addressable position inside a source document.
 *
 * Open-ended by design: a transcript is addressed by speaker and timestamp, a
 * paginated document by page and paragraph, and neither reduces to the other.
 * Add a variant when a new evidence kind arrives; do not flatten them.
 */
export type Cite =
  /** Paginated text — extracted markdown, PDFs once OCR lands. */
  | { kind: 'page'; page: number; para: number }
  /** Time-coded speech — consultation and hearing transcripts. */
  | { kind: 'time'; speaker: string; tMs: number };

/**
 * One addressable stretch of a document.
 *
 * `confidence` is left undefined for exact text and populated by producers that
 * infer position — OCR most obviously. A consumer that ignores it still behaves
 * correctly on exact text, which is what lets OCR arrive later without touching
 * anything downstream.
 */
export interface EvidenceRegion {
  /**
   * Half-open `[start, end)` character offsets into
   * {@link EvidenceDocument.text}, in UTF-16 code units — i.e. plain JavaScript
   * string indices, so `text.slice(...span)` is the region's text with no
   * conversion. Half-open so adjacent regions share a boundary without
   * overlapping.
   */
  span: [number, number];
  locator: Cite;
  /** 0–1 positional confidence. Undefined means exact. */
  confidence?: number;
}

/**
 * A document with enough structure to cite, not merely to read.
 *
 * INVARIANTS a producer must hold, and {@link assertWellFormedDocument} checks:
 * regions are sorted by `span[0]`, non-overlapping, and within `text`. Gaps are
 * permitted — a document may have unaddressable stretches (page furniture,
 * silence between utterances) and an assertion falling entirely in a gap simply
 * resolves to no cite, which is honest rather than fabricated.
 */
export interface EvidenceDocument {
  id: string;
  text: string;
  /** Sorted by `span[0]`, non-overlapping. May not cover all of `text`. */
  regions: EvidenceRegion[];
  metadata?: {
    /** When the document itself was created — the anchor for relative dates. */
    createdAt?: string;
    publishedAt?: string;
  };
}

/**
 * Every locator a span touches.
 *
 * Returns ALL intersecting regions rather than the one containing the start
 * offset, because a supporting sentence routinely crosses a paragraph, a page,
 * or a change of speaker — and a citation that named only where it began would
 * send a reader to the wrong half of the evidence.
 *
 * Intersection is half-open on both sides: a span ending exactly where a region
 * begins does not touch it.
 *
 * @param doc  The document the span indexes into
 * @param span Half-open `[start, end)` offsets
 * @returns Locators in document order; empty when the span lies wholly in a gap
 */
export function resolveCites(
  doc: EvidenceDocument,
  span: [number, number],
): Cite[] {
  const [start, end] = span;
  if (end <= start) return [];
  const out: Cite[] = [];
  for (const region of doc.regions) {
    const [rs, re] = region.span;
    // Regions are sorted, so once one starts at or after the span's end,
    // nothing later can intersect.
    if (rs >= end) break;
    if (re > start) out.push(region.locator);
  }
  return out;
}

/** Thrown by {@link assertWellFormedDocument}. */
export class EvidenceDocumentError extends Error {
  constructor(readonly documentId: string, detail: string) {
    super(`EvidenceDocument ${JSON.stringify(documentId)}: ${detail}`);
    this.name = 'EvidenceDocumentError';
  }
}

/**
 * Fail loudly on a malformed document, at the boundary where it enters.
 *
 * Every downstream guarantee — that a span resolves, that citations are in
 * document order, that {@link resolveCites} can stop early — rests on the
 * ordering invariant. A producer that emits regions out of order yields
 * citations that are quietly wrong rather than absent, which is the failure mode
 * this contract exists to prevent. Checking once on entry is cheaper than
 * distrusting every read.
 */
export function assertWellFormedDocument(doc: EvidenceDocument): void {
  let previousEnd = -1;
  let previousStart = -1;
  for (const [i, region] of doc.regions.entries()) {
    const [start, end] = region.span;
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new EvidenceDocumentError(doc.id, `region ${i} span is not integral`);
    }
    if (end <= start) {
      throw new EvidenceDocumentError(doc.id, `region ${i} span is empty or inverted`);
    }
    if (start < 0 || end > doc.text.length) {
      throw new EvidenceDocumentError(
        doc.id,
        `region ${i} span [${start}, ${end}) falls outside text of length ${doc.text.length}`,
      );
    }
    if (start < previousStart) {
      throw new EvidenceDocumentError(doc.id, `region ${i} is not sorted by span start`);
    }
    if (start < previousEnd) {
      throw new EvidenceDocumentError(
        doc.id,
        `region ${i} overlaps the previous region (starts at ${start}, previous ended at ${previousEnd})`,
      );
    }
    previousStart = start;
    previousEnd = end;
  }
}
