/**
 * The chronology, and the distinctions that must survive to reach it.
 *
 * Every field here exists because flattening it misstates something a
 * professional acts on. That is the test for adding another.
 *
 * @packageDocumentation
 */

import type { Cite } from '@lloyal-labs/lloyal-agents';

/** How precisely the source pinned the date. Never widened by inference. */
export type DateGranularity = 'day' | 'month' | 'year';

/** How the date was arrived at — audit needs this, not just the value. */
export type DateBasis = 'explicit' | 'relative' | 'inferred';

/**
 * A resolved date, carrying its own precision.
 *
 * `value` is ISO, TRUNCATED to `granularity`: `"March 2024"` becomes
 * `"2024-03"`, never `"2024-03-01"`. Inventing a day that the source did not
 * state is the failure that makes a chronology unusable in front of someone
 * else, and it is invisible once written.
 */
export interface NormalisedDate {
  value: string;
  granularity: DateGranularity;
  basis: DateBasis;
  /** Set when `basis === 'relative'` — what the offset was measured from. */
  anchorId?: string;
}

/**
 * What the source says happened, and in what sense.
 *
 * TWO INDEPENDENT DIMENSIONS. "The patient reported that surgery was scheduled
 * for Friday" is `reported` × `scheduled`; "the taxpayer alleged that payment
 * had occurred" is `alleged` × `occurred`. One enum can express neither.
 */
export type TemporalStatus =
  | 'occurred'
  | 'scheduled'
  | 'due'
  | 'effective'
  | 'cancelled'
  | 'hypothetical';

/** Who is standing behind the claim, and how directly. */
export type EpistemicStatus = 'observed' | 'recorded' | 'reported' | 'alleged';

/** Evidence for one assertion, addressable by a human. */
export interface AssertionSupport {
  docId: string;
  /** Half-open `[start, end)` offsets into the document's text. */
  span: [number, number];
  /** Every region the span touches — a sentence can cross a page or speaker. */
  cites: Cite[];
}

/**
 * One claim about one event.
 *
 * Evidence hangs off the ASSERTION rather than the row: when two sources
 * disagree, a caller must be able to tell which citation supports which claim,
 * and a row-level support list cannot say.
 */
export interface TimelineAssertion {
  id: string;
  description: string;
  temporalStatus: TemporalStatus;
  epistemicStatus: EpistemicStatus;
  /** `negated` records that the source says it did NOT happen. Still an event. */
  polarity: 'affirmed' | 'negated';
  /** Who asserts it, when the source attributes the claim. */
  attributedTo?: string;
  supports: AssertionSupport[];
}

/** One dated line of the chronology. */
export interface TimelineRow {
  id: string;
  /** `null` means undatable — the row lives in `unresolved`, never guessed. */
  date: NormalisedDate | null;
  /** ≥1. More than one means the sources disagree and both were kept. */
  assertions: TimelineAssertion[];
}

/**
 * The deliverable.
 *
 * `unresolved` and `unprocessed` are load-bearing: a chronology with a silent
 * hole is a liability, one with a visible gap is a task for someone.
 */
export interface TimelineResult {
  /** Dated, ordered by date then by first support offset. */
  rows: TimelineRow[];
  /** Events with no datable anchor. Recorded, never dropped, never guessed. */
  unresolved: TimelineRow[];
  /** Segments that failed. Their absence would otherwise be invisible. */
  unprocessed: { docId: string; span?: [number, number]; reason: string }[];
  /** Every segment the run was given, so coverage is checkable (T1). */
  segmentsSeen: number;
}
