/**
 * T1–T5 — properties that hold on every run, and fail in exactly one phase.
 *
 * A wrong chronology has five plausible authors: segmentation, extraction, the
 * date adapter, reconciliation, support judging. Accuracy metrics say the output
 * is wrong and never say which produced it, and with agents forking off a shared
 * spine, re-running does not reliably reproduce the same wrongness.
 *
 * So these are properties rather than measurements. They need no gold labels,
 * they run on any corpus a developer points at, and each is chosen so that when
 * it goes red, one phase is implicated and the others are not.
 *
 * Convention follows packages/agents/test/invariants/predicates.ts: `ok`/`fail`
 * are module-private, predicates take the run and return a PredicateResult, and
 * `formatResult` renders violations for expect() output.
 */

import type { EvidenceDocument } from '@lloyal-labs/lloyal-agents';
import { resolveCites } from '@lloyal-labs/lloyal-agents';
import { segmentDocument } from '../src/segment';
import type { TimelineResult, TimelineRow } from '../src/types';

export interface Violation {
  invariant: string;
  detail: string;
}

export interface PredicateResult {
  ok: boolean;
  violations: Violation[];
}

function ok(): PredicateResult {
  return { ok: true, violations: [] };
}

function fail(invariant: string, detail: string): PredicateResult {
  return { ok: false, violations: [{ invariant, detail }] };
}

/** A run's inputs and output — the sole input to every predicate below. */
export interface TimelineRun {
  documents: EvidenceDocument[];
  result: TimelineResult;
  /** Segment size the run used, so T1 can recompute the expected count. */
  segmentChars?: number;
}

const allRows = (r: TimelineResult): TimelineRow[] => [...r.rows, ...r.unresolved];

/**
 * T1 — every segment is accounted for.
 *
 * Localises: the wave loop. A segment that is silently skipped produces a
 * chronology with a hole nobody can see, which is the failure that makes the
 * whole artifact untrustworthy. Coverage is checkable without gold labels
 * because segmentation is deterministic.
 */
export function T1_segmentsAccountedFor(run: TimelineRun): PredicateResult {
  const expected = run.documents.reduce(
    (n, doc) => n + segmentDocument(doc, run.segmentChars).length,
    0,
  );
  const seen = run.result.segmentsSeen;
  const failedDocs = new Set(
    run.result.unprocessed.filter((u) => u.span === undefined).map((u) => u.docId),
  );
  // A document rejected before segmentation contributes no segments.
  const expectedAfterRejects = run.documents.reduce(
    (n, doc) =>
      failedDocs.has(doc.id) ? n : n + segmentDocument(doc, run.segmentChars).length,
    0,
  );
  if (seen !== expectedAfterRejects) {
    return fail(
      'T1',
      `run reports ${seen} segments seen, but the documents partition into ` +
        `${expectedAfterRejects} (${expected} before ${failedDocs.size} rejected document(s))`,
    );
  }
  return ok();
}

/**
 * T2 — every span is real and addressable.
 *
 * Localises: the locator seam and the segment→document offset conversion. A span
 * outside its document, or one landing in no region, is a citation a reader
 * cannot open — and offset arithmetic is exactly where a segment-local index
 * escapes into a document-level field.
 */
export function T2_spansResolve(run: TimelineRun): PredicateResult {
  const byId = new Map(run.documents.map((d) => [d.id, d]));
  for (const row of allRows(run.result)) {
    for (const assertion of row.assertions) {
      for (const support of assertion.supports) {
        const doc = byId.get(support.docId);
        if (!doc) {
          return fail('T2', `support cites unknown document ${JSON.stringify(support.docId)}`);
        }
        const [start, end] = support.span;
        if (start < 0 || end > doc.text.length || end <= start) {
          return fail(
            'T2',
            `span [${start}, ${end}) is outside ${JSON.stringify(support.docId)} ` +
              `(length ${doc.text.length}) — a segment-local offset that escaped conversion`,
          );
        }
        const expected = resolveCites(doc, support.span);
        if (JSON.stringify(support.cites) !== JSON.stringify(expected)) {
          return fail(
            'T2',
            `cites for [${start}, ${end}) disagree with the document's regions`,
          );
        }
        // The check that catches an in-bounds WRONG span. A segment-local offset
        // that escaped conversion still lands inside the document and still
        // resolves to a region; only the text betrays it.
        const actual = doc.text.slice(start, end);
        if (actual !== support.quote) {
          return fail(
            'T2',
            `span [${start}, ${end}) in ${JSON.stringify(support.docId)} reads ` +
              `${JSON.stringify(actual.slice(0, 50))} but the extractor quoted ` +
              `${JSON.stringify(support.quote.slice(0, 50))} — the offset is in ` +
              `bounds and points at the wrong text`,
          );
        }
      }
    }
  }
  return ok();
}

/**
 * T3 — the cited span carries the words the date came from.
 *
 * Localises: extraction. A row dated from text outside its own citation is
 * unverifiable by the reader it was produced for — the span may be plausible and
 * the date may be right, and neither can be checked.
 */
export function T3_citedSpanCarriesTheDateText(
  run: TimelineRun,
  dateTextOf: (rowId: string) => string | undefined,
): PredicateResult {
  const byId = new Map(run.documents.map((d) => [d.id, d]));
  for (const row of allRows(run.result)) {
    const dateText = dateTextOf(row.id);
    if (!dateText) continue;
    const support = row.assertions[0]?.supports[0];
    if (!support) {
      return fail('T3', `row ${row.id} has no support to check the date text against`);
    }
    const doc = byId.get(support.docId);
    if (!doc) continue;
    const cited = doc.text.slice(...support.span);
    if (!cited.includes(dateText)) {
      return fail(
        'T3',
        `row ${row.id} was dated from ${JSON.stringify(dateText)}, which does not ` +
          `appear in its cited span ${JSON.stringify(cited.slice(0, 60))}`,
      );
    }
  }
  return ok();
}

/**
 * T4 — a relative date names an anchor that exists.
 *
 * Localises: the date adapter and anchor discovery. `basis: 'relative'` without
 * a resolvable `anchorId` means the offset was measured from something the run
 * cannot name — which is indistinguishable, in the output, from measuring it
 * against today.
 */
export function T4_relativeDatesNameTheirAnchor(
  run: TimelineRun,
  anchorIds: ReadonlySet<string>,
): PredicateResult {
  for (const row of run.result.rows) {
    if (row.date?.basis !== 'relative') continue;
    if (!row.date.anchorId) {
      return fail('T4', `row ${row.id} is relative but names no anchor`);
    }
    if (!anchorIds.has(row.date.anchorId)) {
      return fail(
        'T4',
        `row ${row.id} is relative to ${JSON.stringify(row.date.anchorId)}, ` +
          `which was never established`,
      );
    }
  }
  return ok();
}

/**
 * T5 — no date claims precision the source did not give.
 *
 * Localises: the date adapter. `"March 2024"` becoming `2024-03-01` invents a
 * day, and once written nothing downstream can tell it was invented — it sorts,
 * renders and reads exactly like a stated one.
 */
export function T5_precisionIsNotInvented(run: TimelineRun): PredicateResult {
  const shape = { day: /^\d{4}-\d{2}-\d{2}$/, month: /^\d{4}-\d{2}$/, year: /^\d{4}$/ };
  for (const row of run.result.rows) {
    if (!row.date) continue;
    const { value, granularity } = row.date;
    if (!shape[granularity].test(value)) {
      return fail(
        'T5',
        `row ${row.id} claims ${granularity} precision but its value is ` +
          `${JSON.stringify(value)} — truncate to the precision actually known`,
      );
    }
  }
  return ok();
}

/** A row with a date is never also in `unresolved`, and vice versa. */
export function T5b_datedAndUnresolvedAreDisjoint(run: TimelineRun): PredicateResult {
  const dated = new Set(run.result.rows.map((r) => r.id));
  for (const row of run.result.unresolved) {
    if (dated.has(row.id)) {
      return fail('T5b', `row ${row.id} appears in both rows and unresolved`);
    }
    if (row.date !== null) {
      return fail('T5b', `row ${row.id} is in unresolved but carries a date`);
    }
  }
  return ok();
}

/** Render a PredicateResult for expect() output. */
export function formatResult(name: string, r: PredicateResult): string {
  if (r.ok) return `${name}: ok`;
  return `${name}: ${r.violations.map((v) => `[${v.invariant}] ${v.detail}`).join('; ')}`;
}
