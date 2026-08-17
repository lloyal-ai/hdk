/**
 * T1–T5 against fixtures designed to fail in one phase each.
 *
 * A fixture that exercises everything tells you nothing when it breaks. Each of
 * these isolates a phase by construction, so a red test names its own cause:
 *
 *   span-boundary   a supporting sentence crossing a page break
 *   partial-parse   the three date expressions chrono gets confidently wrong
 *   oversized-doc   one long document beside several short ones
 *   malformed-doc   evidence whose regions are unusable
 *
 * The extractor is injected, so every phase below runs without a model. That is
 * deliberate: invariants that need weights are invariants nobody runs.
 */
import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import type { EvidenceDocument } from '@lloyal-labs/lloyal-agents';
import { BuildTimelineTool, type ExtractedEvent } from '../src/tools/build-timeline';
import type { TimelineResult } from '../src/types';
import {
  T1_segmentsAccountedFor,
  T2_spansResolve,
  T3_citedSpanCarriesTheDateText,
  T4_relativeDatesNameTheirAnchor,
  T5_precisionIsNotInvented,
  T5b_datedAndUnresolvedAreDisjoint,
  formatResult,
  type TimelineRun,
} from './predicates';

/** Paginate text into regions of `per` chars — page 1 ¶1, ¶2, page 2 ¶1, … */
function paginate(id: string, text: string, per = 60, createdAt?: string): EvidenceDocument {
  const regions = [];
  for (let i = 0, n = 0; i < text.length; i += per, n++) {
    regions.push({
      span: [i, Math.min(i + per, text.length)] as [number, number],
      locator: {
        kind: 'page' as const,
        page: Math.floor(n / 2) + 1,
        para: (n % 2) + 1,
      },
    });
  }
  return { id, text, regions, ...(createdAt ? { metadata: { createdAt } } : {}) };
}

async function build(
  documents: EvidenceDocument[],
  events: (segText: string, docId: string) => ExtractedEvent[],
  segmentChars = 200,
): Promise<TimelineRun> {
  const tool = new BuildTimelineTool({
    locale: 'en-GB',
    segmentChars,
    extract: function* (segText, docId) {
      return events(segText, docId);
    },
  });
  // `run()` returns a Task — awaiting it is the difference between the result
  // and a pending promise every assertion then reads as undefined.
  const result = (await run(function* () {
    return (yield* tool.execute({ documents })) as TimelineResult;
  })) as TimelineResult;
  return { documents, result, segmentChars };
}

/** An event pointing at `needle` within the segment, dated by `dateExpr`. */
function eventAt(
  segText: string,
  needle: string,
  dateExpr: ExtractedEvent['dateExpr'],
): ExtractedEvent[] {
  const at = segText.indexOf(needle);
  if (at < 0) return [];
  return [
    {
      description: `event: ${needle}`,
      span: [at, at + needle.length],
      quote: needle,
      dateExpr,
      temporalStatus: 'occurred',
      epistemicStatus: 'recorded',
      polarity: 'affirmed',
    },
  ];
}

describe('fixture: span-boundary — a citation crossing a page break', () => {
  // The sentence starts in page 1 ¶2 and finishes in page 2 ¶1. A citation
  // naming only where it began would send a reader to the wrong page.
  const text =
    'A'.repeat(100) + 'the inspection occurred on 18 March 2024 and passed' + 'B'.repeat(60);
  const doc = paginate('bundle', text, 60);

  const mk = () =>
    build([doc], (segText) =>
      eventAt(segText, 'the inspection occurred on 18 March 2024', {
        kind: 'absolute',
        text: '18 March 2024',
      }),
    );

  it('cites every region the span touches', async () => {
    const r = await mk();
    const support = r.result.rows[0]?.assertions[0]?.supports[0];
    expect(support).toBeDefined();
    expect(support!.cites.length).toBeGreaterThan(1);
  });

  it('T2 — spans resolve and cites match the document', async () => {
    const r = await mk();
    const t2 = T2_spansResolve(r);
    expect(t2.ok, formatResult('T2', t2)).toBe(true);
  });

  it('T3 — the cited span contains the date text it was dated from', async () => {
    const r = await mk();
    const t3 = T3_citedSpanCarriesTheDateText(r, () => '18 March 2024');
    expect(t3.ok, formatResult('T3', t3)).toBe(true);
  });
});

describe('fixture: partial-parse — dates chrono gets confidently wrong', () => {
  const text =
    'The review closed at the end of February and the hearing was listed for ' +
    'the 2nd Tuesday of November, with the levy applying in 2024.';
  const doc = paginate('notice', text, 50, '2019-03-14');

  it('refuses the fragments rather than dating them wrongly', async () => {
    // Passed as `absolute` on purpose: this is what reaches the resolver when
    // extraction has NOT decomposed, and the coverage check is the backstop.
    const r = await build([doc], (segText) => [
      ...eventAt(segText, 'the end of February', {
        kind: 'absolute',
        text: 'the end of February',
      }),
      ...eventAt(segText, 'the 2nd Tuesday of November', {
        kind: 'absolute',
        text: 'the 2nd Tuesday of November',
      }),
    ]);
    // Both are unresolved, not dated — visible gaps rather than wrong rows.
    expect(r.result.rows).toHaveLength(0);
    expect(r.result.unresolved.length).toBeGreaterThan(0);
    const t5b = T5b_datedAndUnresolvedAreDisjoint(r);
    expect(t5b.ok, formatResult('T5b', t5b)).toBe(true);
  });

  it('dates them correctly once decomposed, and keeps the precision honest', async () => {
    const r = await build([doc], (segText) => [
      ...eventAt(segText, 'the end of February', {
        kind: 'qualified',
        text: 'the end of February',
        month: 2,
        year: 2024,
        qualifier: 'end-of',
      }),
      ...eventAt(segText, 'in 2024', { kind: 'partial', text: 'in 2024', year: 2024 }),
    ]);
    const values = r.result.rows.map((row) => row.date?.value).sort();
    // The leap year, and a year that stays a year.
    expect(values).toEqual(['2024', '2024-02-29']);
    const t5 = T5_precisionIsNotInvented(r);
    expect(t5.ok, formatResult('T5', t5)).toBe(true);
  });
});

describe('fixture: oversized-doc — one long document beside short ones', () => {
  // Every paragraph is DISTINCT. Repeated text would hide the bug this fixture
  // exists for: with identical paragraphs, a segment-local offset lands on the
  // same words as the correct offset and the identity check cannot tell them
  // apart. Uniqueness is what makes a misplaced span visible.
  const paras = Array.from(
    { length: 60 },
    (_, i) => `Entry ${String(i).padStart(3, '0')}: the officer recorded item ${i}.`,
  );
  const long = paginate('transcript', paras.join('\n\n'), 80);
  const shorts = [1, 2, 3].map((n) => paginate(`memo-${n}`, `Short memo ${n}. `.repeat(3), 40));

  const mk = () =>
    build([long, ...shorts], (segText) => {
      // Target the LAST entry in each segment, so its offset is far from zero
      // and a dropped segment-base is unmistakable.
      const m = [...segText.matchAll(/Entry \d{3}/g)].pop();
      if (!m) return eventAt(segText, 'Short memo', { kind: 'partial', text: '2024', year: 2024 });
      return eventAt(segText, m[0], { kind: 'partial', text: '2024', year: 2024 });
    });

  it('T1 — every segment across every document is accounted for', async () => {
    const r = await mk();
    // The failure this catches: a wave loop that drops the tail of a long
    // document produces a chronology whose gap is invisible.
    const t1 = T1_segmentsAccountedFor(r);
    expect(t1.ok, formatResult('T1', t1)).toBe(true);
    expect(r.result.segmentsSeen).toBeGreaterThan(1);
  });

  it('T2 — offsets stay document-absolute across many segments', async () => {
    const r = await mk();
    // Segment 20's local offset must not escape as a document offset.
    const t2 = T2_spansResolve(r);
    expect(t2.ok, formatResult('T2', t2)).toBe(true);
  });
});

describe('fixture: relative dates and their anchors', () => {
  const text = 'The notice issued. Three days later the objection was lodged.';
  const doc = paginate('assessment', text, 40, '2019-03-14');

  it('T4 — a relative row names an anchor that exists', async () => {
    const r = await build([doc], (segText) =>
      eventAt(segText, 'the objection was lodged', {
        kind: 'relative',
        text: 'Three days later',
        anchorRef: 'assessment:document',
        n: 3,
        unit: 'day',
        dir: 'after',
      }),
    );
    expect(r.result.rows[0]?.date?.value).toBe('2019-03-17');
    const t4 = T4_relativeDatesNameTheirAnchor(r, new Set(['assessment:document']));
    expect(t4.ok, formatResult('T4', t4)).toBe(true);
  });

  it('an unestablished anchor sends the row to unresolved, not to today', async () => {
    const r = await build([doc], (segText) =>
      eventAt(segText, 'the objection was lodged', {
        kind: 'relative',
        text: 'Three days later',
        anchorRef: 'nowhere',
        n: 3,
        unit: 'day',
        dir: 'after',
      }),
    );
    expect(r.result.rows).toHaveLength(0);
    expect(r.result.unresolved).toHaveLength(1);
  });
});

describe('fixture: malformed-doc — evidence that cannot be cited', () => {
  it('reports the document as unprocessed rather than dropping it', async () => {
    const bad: EvidenceDocument = {
      id: 'scrambled',
      text: 'x'.repeat(50),
      // Out of order: citations from this would be quietly wrong.
      regions: [
        { span: [20, 30], locator: { kind: 'page', page: 2, para: 1 } },
        { span: [0, 10], locator: { kind: 'page', page: 1, para: 1 } },
      ],
    };
    const good = paginate('clean', 'The event occurred. '.repeat(4), 40);
    const r = await build([bad, good], (segText) =>
      eventAt(segText, 'The event occurred', { kind: 'partial', text: '2024', year: 2024 }),
    );

    expect(r.result.unprocessed.map((u) => u.docId)).toContain('scrambled');
    // And the good document still produced rows — one bad file does not cost
    // the rest of the matter.
    expect(r.result.rows.length).toBeGreaterThan(0);
    const t1 = T1_segmentsAccountedFor(r);
    expect(t1.ok, formatResult('T1', t1)).toBe(true);
  });

  it('an extractor that throws costs its segment, not the run', async () => {
    const doc = paginate('mixed', 'Alpha event. '.repeat(30), 50);
    const tool = new BuildTimelineTool({
      locale: 'en-GB',
      segmentChars: 100,
      extract: function* (segText) {
        if (segText.includes('Alpha')) throw new Error('extractor exploded');
        return [];
      },
    });
    const result = (await run(function* () {
      return (yield* tool.execute({ documents: [doc] })) as TimelineResult;
    })) as TimelineResult;

    expect(result.unprocessed.length).toBeGreaterThan(0);
    expect(result.unprocessed[0].reason).toMatch(/exploded/);
    // Never thrown out of execute(): dag halts a whole graph on a throw.
    expect(result.segmentsSeen).toBeGreaterThan(0);
  });
});
