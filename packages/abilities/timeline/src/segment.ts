/**
 * Splitting evidence into units of work.
 *
 * A document is not one. A two-paragraph memo and a 600-page hearing transcript
 * are not comparable, and one-agent-per-document makes the ability's floor a
 * function of its largest input — which contradicts cost scaling with how full
 * the cache is rather than how many files arrived.
 *
 * Every segment carries its offsets INTO THE PARENT, so an event extracted from
 * segment 40 still cites a span the reader can open in the original. Offsets are
 * never segment-local; that is the bug this shape exists to prevent.
 *
 * @packageDocumentation
 */

import type { EvidenceDocument } from '@lloyal-labs/lloyal-agents';

export interface TimelineSegment {
  docId: string;
  /** Half-open `[start, end)` offsets into the PARENT document's text. */
  span: [number, number];
  /** `document.text.slice(...span)` — carried so extractors need only this. */
  text: string;
}

/**
 * Target segment size in characters.
 *
 * Characters rather than tokens because segmentation must not depend on a
 * tokenizer being loaded — this runs before any model does, and a segmenter
 * that needs a model is a segmenter that cannot report `unprocessed` when the
 * model is missing.
 */
export const DEFAULT_SEGMENT_CHARS = 4000;

/**
 * Split on paragraph boundaries, packing up to `maxChars`.
 *
 * Boundaries are preferred over exact sizes: a segment that ends mid-sentence
 * costs an extraction the context it needed, and the saving is nothing. A single
 * paragraph longer than `maxChars` becomes its own oversized segment rather than
 * being cut — losing a sentence is worse than a wide segment.
 */
export function segmentDocument(
  doc: EvidenceDocument,
  maxChars: number = DEFAULT_SEGMENT_CHARS,
): TimelineSegment[] {
  if (doc.text.length === 0) return [];

  const segments: TimelineSegment[] = [];
  const boundary = /\n\s*\n/g;

  // Paragraph start offsets, in the parent's coordinates.
  const starts: number[] = [0];
  for (let m = boundary.exec(doc.text); m !== null; m = boundary.exec(doc.text)) {
    starts.push(m.index + m[0].length);
  }
  starts.push(doc.text.length);

  let segStart = 0;
  for (let i = 1; i < starts.length; i++) {
    const paraEnd = starts[i];
    const wouldBe = paraEnd - segStart;
    const isLast = i === starts.length - 1;

    if (wouldBe >= maxChars || isLast) {
      // Close the current segment at this boundary. `>= maxChars` rather than
      // `>` so a single oversized paragraph closes immediately as its own
      // segment instead of accreting the next one.
      const end = paraEnd;
      if (end > segStart) {
        segments.push({
          docId: doc.id,
          span: [segStart, end],
          text: doc.text.slice(segStart, end),
        });
      }
      segStart = end;
    }
  }

  return segments;
}
