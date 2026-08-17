/**
 * Date resolution — and, more importantly, date refusal.
 *
 * The fixtures below are not invented. They are what chrono-node 2.10.1 actually
 * returns, measured against a 2019-03-14 anchor: it answers "the end of
 * February" with 1 February and "the 2nd Tuesday of November" with a Tuesday in
 * March, by matching a fragment and discarding the qualifier. Both answers are
 * well-formed and wrong, which is the combination that reaches a filing.
 *
 * So the tests that matter here are the ones asserting we DON'T produce a date.
 */
import { describe, it, expect } from 'vitest';
import { createDateResolver, type DateAnchor, type DateExpr } from '../src/dates';

const GB = createDateResolver('en-GB');
const US = createDateResolver('en-US');
const DOC: DateAnchor[] = [{ id: 'doc', value: '2019-03-14' }];

describe('partial dates stay partial', () => {
  it('"March 2024" is a month, not the first of the month', () => {
    // The single most damaging silent behaviour: inventing a day the source
    // never stated, then sorting a chronology by it.
    const r = GB.resolve({ kind: 'partial', text: 'March 2024', year: 2024, month: 3 }, []);
    expect(r.ok && r.date).toEqual({
      value: '2024-03',
      granularity: 'month',
      basis: 'explicit',
    });
  });

  it('"in 2024" is a year — chrono cannot parse it at all', () => {
    // Verified: chrono.parse('in 2024') returns []. Decomposed extraction is
    // what rescues it; a raw parser would drop the event entirely.
    const r = GB.resolve({ kind: 'partial', text: 'in 2024', year: 2024 }, []);
    expect(r.ok && r.date).toEqual({
      value: '2024',
      granularity: 'year',
      basis: 'explicit',
    });
  });
});

describe('qualified expressions are computed, never parsed', () => {
  it('"the end of February" 2024 is the 29th — a leap year', () => {
    // The spec said "the 28th" for two revisions. February has 29 days in 2024,
    // and a chronology that is off by a day is a chronology that is wrong.
    const r = GB.resolve(
      { kind: 'qualified', text: 'the end of February', month: 2, year: 2024, qualifier: 'end-of' },
      [],
    );
    expect(r.ok && r.date.value).toBe('2024-02-29');
  });

  it('"the end of February" 2019 is the 28th', () => {
    const r = GB.resolve(
      { kind: 'qualified', text: 'the end of February', month: 2, year: 2019, qualifier: 'end-of' },
      [],
    );
    expect(r.ok && r.date.value).toBe('2019-02-28');
  });

  it('takes its year from an anchor when the source omitted one', () => {
    const r = GB.resolve(
      { kind: 'qualified', text: 'end of February', month: 2, anchorRef: 'doc', qualifier: 'end-of' },
      DOC,
    );
    expect(r.ok && r.date.value).toBe('2019-02-28');
  });

  it('refuses when neither a year nor an anchor supplies one', () => {
    const r = GB.resolve(
      { kind: 'qualified', text: 'end of February', month: 2, qualifier: 'end-of' },
      [],
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('incomplete-qualifier');
  });

  it('"early 2024" stays a year rather than becoming a day', () => {
    const r = GB.resolve({ kind: 'qualified', text: 'early 2024', year: 2024, qualifier: 'start-of' }, []);
    expect(r.ok && r.date).toMatchObject({ value: '2024', granularity: 'year' });
  });
});

describe('relative expressions resolve against their anchor, never against now', () => {
  it('"three days later" against a 2019 document lands in 2019', () => {
    // The whole reason chrono was chosen over Sugar: an arbitrary reference
    // date. Anchored to now this would land in the present and look plausible.
    const r = GB.resolve(
      { kind: 'relative', text: 'three days later', anchorRef: 'doc', n: 3, unit: 'day', dir: 'after' },
      DOC,
    );
    expect(r.ok && r.date).toMatchObject({
      value: '2019-03-17',
      basis: 'relative',
      anchorId: 'doc',
    });
  });

  it('counts backwards for "before"', () => {
    const r = GB.resolve(
      { kind: 'relative', text: 'two weeks earlier', anchorRef: 'doc', n: 2, unit: 'week', dir: 'before' },
      DOC,
    );
    expect(r.ok && r.date.value).toBe('2019-02-28');
  });

  it('refuses when the anchor was never established', () => {
    // An unanchored relative date is unplaceable. Guessing one is how a
    // chronology acquires a confident wrong row.
    const r = GB.resolve(
      { kind: 'relative', text: 'three days later', anchorRef: 'nope', n: 3, unit: 'day', dir: 'after' },
      DOC,
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('missing-anchor');
  });
});

describe('absolute expressions are coverage-checked', () => {
  it('accepts a date that fills its phrase', () => {
    const r = GB.resolve({ kind: 'absolute', text: '18 March 2024' }, []);
    expect(r.ok && r.date).toMatchObject({ value: '2024-03-18', granularity: 'day' });
  });

  it('REFUSES "the end of February" rather than answering 1 February', () => {
    // chrono matches only "February" here and returns the 1st. This is the
    // measured failure the coverage check exists for.
    const r = GB.resolve({ kind: 'absolute', text: 'the end of February' }, DOC);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('partial-parse');
    expect(!r.ok && r.detail).toMatch(/understood/);
  });

  it('REFUSES "the 2nd Tuesday of November" rather than answering a Tuesday in March', () => {
    const r = GB.resolve({ kind: 'absolute', text: 'the 2nd Tuesday of November' }, DOC);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('partial-parse');
  });

  it('reports no-parse distinctly from partial-parse', () => {
    // A developer debugging a gap needs to know whether the parser saw nothing
    // or saw a fragment — different causes, different fixes.
    const r = GB.resolve({ kind: 'absolute', text: 'shortly afterwards' }, []);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('no-parse');
  });

  it('never reports a precision the source did not state', () => {
    const r = GB.resolve({ kind: 'absolute', text: 'March 2024' }, []);
    expect(r.ok && r.date.granularity).toBe('month');
    expect(r.ok && r.date.value).toBe('2024-03');
  });
});

describe('locale is load-bearing', () => {
  it('reads 03/04/24 a year apart under en-GB and en-US', () => {
    // This is why locale is required with no default: the same eight characters
    // are 3 April or 4 March, and nothing downstream can tell which was meant.
    const gb = GB.resolve({ kind: 'absolute', text: '03/04/24' }, []);
    const us = US.resolve({ kind: 'absolute', text: '03/04/24' }, []);
    expect(gb.ok && gb.date.value).toBe('2024-04-03');
    expect(us.ok && us.date.value).toBe('2024-03-04');
  });
});
