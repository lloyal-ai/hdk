/**
 * Turning a date expression into a date, or refusing to.
 *
 * The model reads; this computes. It decides what a phrase MEANS — an absolute
 * date, an offset from something, a qualified month, a partial year — and the
 * arithmetic happens here, deterministically. A language model doing date
 * arithmetic is strictly worse than `addDays`, and a parser deciding what counts
 * as an event is strictly worse than a reader.
 *
 * THE HARD PART IS REFUSING. Natural-language date parsers answer confidently
 * when they have understood only a fragment. Measured against chrono-node
 * 2.10.1, anchored to 2019-03-14:
 *
 *   "the end of February"          → 2019-02-01   (matched "February")
 *   "the 2nd Tuesday of November"  → 2019-03-12   (matched "Tuesday")
 *   "in 2024"                      → no parse
 *
 * The first two are wrong and well-formed, which is the dangerous combination.
 * So every parse is coverage-checked: if the parser consumed materially less
 * than the phrase the extractor identified, the result is discarded and the
 * event goes to `unresolved`. A visible gap beats a confident wrong date.
 *
 * @packageDocumentation
 */

import * as chrono from 'chrono-node';
import type { NormalisedDate } from './types';

/**
 * A date expression, already decomposed by the extractor.
 *
 * The model emits structure rather than prose precisely so the ambiguity class
 * above never reaches a parser: "the end of February" arrives as
 * `{kind:'qualified', month:2, qualifier:'end-of'}` and is resolved by
 * arithmetic, not guessed at.
 */
export type DateExpr =
  /** As written: "18 March 2024", "03/04/24". Parsed, then coverage-checked. */
  | { kind: 'absolute'; text: string }
  /** "three days later", "the following Monday" — needs `anchorRef`. */
  | {
      kind: 'relative';
      text: string;
      anchorRef: string;
      n: number;
      unit: 'day' | 'week' | 'month' | 'year';
      dir: 'before' | 'after';
    }
  /** "the end of February", "early 2024" — resolved by rule, never parsed. */
  | {
      kind: 'qualified';
      text: string;
      month?: number;
      year?: number;
      anchorRef?: string;
      qualifier: 'start-of' | 'mid' | 'end-of';
    }
  /** "March 2024", "in 2024" — deliberately imprecise, and stays that way. */
  | { kind: 'partial'; text: string; year: number; month?: number };

/** An established fixed point a relative expression can be measured from. */
export interface DateAnchor {
  id: string;
  /** ISO date. */
  value: string;
}

/** Why a resolution was refused. Surfaced so a developer can act on it. */
export type UnresolvedReason =
  | 'no-parse'
  | 'partial-parse'
  | 'missing-anchor'
  | 'incomplete-qualifier';

export type DateResolution =
  | { ok: true; date: NormalisedDate }
  | { ok: false; reason: UnresolvedReason; detail: string };

export interface DateResolver {
  resolve(expr: DateExpr, anchors: readonly DateAnchor[]): DateResolution;
}

/**
 * Fraction of the phrase a parser must consume for its answer to be trusted.
 *
 * "the end of February" is 19 characters and chrono matches 8 of them (~0.42),
 * which is the fragment case. An exact-length rule would be too strict — parsers
 * legitimately trim articles and trailing punctuation — so the bar is
 * proportional, and stated rather than tuned silently.
 */
const MIN_COVERAGE = 0.8;

/** Normalise for coverage comparison: parsers vary on case and punctuation. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,;:]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ISO date truncated to the precision actually known. */
function truncate(d: Date, granularity: 'day' | 'month' | 'year'): string {
  const iso = d.toISOString();
  if (granularity === 'year') return iso.slice(0, 4);
  if (granularity === 'month') return iso.slice(0, 7);
  return iso.slice(0, 10);
}

/** Days in a month, so "end of February" is the 29th in a leap year. */
function lastDayOfMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * chrono-backed resolver — the only implementation.
 *
 * chrono is the sole natural-language parser whose `parse()` accepts an
 * arbitrary reference date, which is the whole requirement for historical
 * documents: "three days later" in a 2019 transcript must resolve against 2019.
 * Sugar's parser is pinned to now, and moment, Luxon, date-fns and Temporal
 * parse formats rather than prose.
 */
export class ChronoDateResolver implements DateResolver {
  private readonly _parser: chrono.Chrono;

  /**
   * @param locale Selects the parser. REQUIRED — `03/04/24` is 3 April under
   *   en-GB and 4 March under en-US, and a default would make a chronology
   *   silently wrong by a year.
   */
  constructor(private readonly locale: string) {
    this._parser = locale.toLowerCase().startsWith('en-us')
      ? chrono.en.casual
      : chrono.en.GB;
  }

  resolve(expr: DateExpr, anchors: readonly DateAnchor[]): DateResolution {
    switch (expr.kind) {
      case 'partial':
        return this._partial(expr);
      case 'qualified':
        return this._qualified(expr, anchors);
      case 'relative':
        return this._relative(expr, anchors);
      case 'absolute':
        return this._absolute(expr, anchors);
    }
  }

  /** Imprecise by construction — the whole point is that it stays imprecise. */
  private _partial(
    expr: Extract<DateExpr, { kind: 'partial' }>,
  ): DateResolution {
    const granularity = expr.month === undefined ? 'year' : 'month';
    const value =
      granularity === 'year'
        ? String(expr.year).padStart(4, '0')
        : `${String(expr.year).padStart(4, '0')}-${String(expr.month).padStart(2, '0')}`;
    return { ok: true, date: { value, granularity, basis: 'explicit' } };
  }

  /** Resolved by rule. "End of February" is the 28th or the 29th — computed. */
  private _qualified(
    expr: Extract<DateExpr, { kind: 'qualified' }>,
    anchors: readonly DateAnchor[],
  ): DateResolution {
    const year =
      expr.year ??
      (expr.anchorRef
        ? Number(anchors.find((a) => a.id === expr.anchorRef)?.value.slice(0, 4))
        : undefined);
    if (!year || Number.isNaN(year)) {
      return {
        ok: false,
        reason: 'incomplete-qualifier',
        detail: `${JSON.stringify(expr.text)} has no year and no anchor to take one from`,
      };
    }
    if (expr.month === undefined) {
      // "early 2024" — a season, not a date. Honest as a year.
      return {
        ok: true,
        date: { value: String(year), granularity: 'year', basis: 'inferred' },
      };
    }
    const day =
      expr.qualifier === 'start-of'
        ? 1
        : expr.qualifier === 'mid'
          ? 15
          : lastDayOfMonth(year, expr.month);
    const value = `${String(year).padStart(4, '0')}-${String(expr.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { ok: true, date: { value, granularity: 'day', basis: 'inferred' } };
  }

  /** Arithmetic against a named anchor. Never against "now". */
  private _relative(
    expr: Extract<DateExpr, { kind: 'relative' }>,
    anchors: readonly DateAnchor[],
  ): DateResolution {
    const anchor = anchors.find((a) => a.id === expr.anchorRef);
    if (!anchor) {
      return {
        ok: false,
        reason: 'missing-anchor',
        detail: `${JSON.stringify(expr.text)} is relative to ${JSON.stringify(expr.anchorRef)}, which was not established`,
      };
    }
    const base = new Date(`${anchor.value}T00:00:00Z`);
    if (Number.isNaN(base.getTime())) {
      return {
        ok: false,
        reason: 'missing-anchor',
        detail: `anchor ${JSON.stringify(expr.anchorRef)} has an unparseable value ${JSON.stringify(anchor.value)}`,
      };
    }
    const sign = expr.dir === 'before' ? -1 : 1;
    const out = new Date(base);
    const n = sign * expr.n;
    if (expr.unit === 'day') out.setUTCDate(out.getUTCDate() + n);
    else if (expr.unit === 'week') out.setUTCDate(out.getUTCDate() + n * 7);
    else if (expr.unit === 'month') out.setUTCMonth(out.getUTCMonth() + n);
    else out.setUTCFullYear(out.getUTCFullYear() + n);

    return {
      ok: true,
      date: {
        value: truncate(out, 'day'),
        granularity: 'day',
        basis: 'relative',
        anchorId: anchor.id,
      },
    };
  }

  /**
   * Parsed, then coverage-checked.
   *
   * The check is the point: chrono answers "the end of February" with 1
   * February by matching the word "February" and discarding the qualifier. The
   * result is well-formed and wrong, and only comparing what it consumed
   * against what it was given reveals it.
   */
  private _absolute(
    expr: Extract<DateExpr, { kind: 'absolute' }>,
    anchors: readonly DateAnchor[],
  ): DateResolution {
    const ref = anchors.length > 0 ? new Date(`${anchors[0].value}T00:00:00Z`) : undefined;
    const results = this._parser.parse(
      expr.text,
      ref && !Number.isNaN(ref.getTime()) ? ref : undefined,
    );
    if (results.length === 0) {
      return {
        ok: false,
        reason: 'no-parse',
        detail: `no date found in ${JSON.stringify(expr.text)}`,
      };
    }
    const r = results[0];

    const consumed = normalise(r.text).length;
    const given = normalise(expr.text).length;
    if (given > 0 && consumed / given < MIN_COVERAGE) {
      return {
        ok: false,
        reason: 'partial-parse',
        detail:
          `only ${JSON.stringify(r.text)} of ${JSON.stringify(expr.text)} was ` +
          `understood (${Math.round((consumed / given) * 100)}% < ${MIN_COVERAGE * 100}%); ` +
          `the rest changes the meaning`,
      };
    }

    // Precision comes from what chrono was CERTAIN of, not from the Date it
    // returned — it fills unknown components silently, and reporting those as
    // known is exactly the invented precision this refuses to produce.
    const granularity: 'day' | 'month' | 'year' = r.start.isCertain('day')
      ? 'day'
      : r.start.isCertain('month')
        ? 'month'
        : 'year';

    return {
      ok: true,
      date: {
        value: truncate(r.start.date(), granularity),
        granularity,
        basis: 'explicit',
      },
    };
  }
}

/** Construct the resolver. `locale` is required — see the constructor. */
export function createDateResolver(locale: string): DateResolver {
  return new ChronoDateResolver(locale);
}

export type { NormalisedDate } from './types';
