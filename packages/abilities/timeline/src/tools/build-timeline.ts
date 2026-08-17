import type { Operation } from 'effection';
import { Tool, resolveCites, assertWellFormedDocument } from '@lloyal-labs/lloyal-agents';
import type { EvidenceDocument, JsonSchema } from '@lloyal-labs/lloyal-agents';
import { segmentDocument, DEFAULT_SEGMENT_CHARS } from '../segment';
import { createDateResolver, type DateAnchor, type DateExpr } from '../dates';
import type {
  AssertionSupport,
  TimelineAssertion,
  TimelineResult,
  TimelineRow,
} from '../types';

/**
 * One extracted claim, as the model reports it.
 *
 * The date arrives DECOMPOSED — `{kind:'qualified', month:2, qualifier:'end-of'}`
 * rather than the string "the end of February" — because a parser handed that
 * string answers with 1 February and looks certain. The model says what the
 * phrase means; arithmetic happens in `dates.ts`.
 */
export interface ExtractedEvent {
  description: string;
  /** Offsets into the SEGMENT; converted to document offsets before citing. */
  span: [number, number];
  dateExpr: DateExpr;
  temporalStatus: TimelineAssertion['temporalStatus'];
  epistemicStatus: TimelineAssertion['epistemicStatus'];
  polarity: TimelineAssertion['polarity'];
  attributedTo?: string;
}

/** Supplied by the harness; the model half is injected so this stays testable. */
export type Extractor = (
  segmentText: string,
  docId: string,
) => Operation<ExtractedEvent[]>;

export interface BuildTimelineOpts {
  locale: string;
  segmentChars?: number;
  /**
   * How events are pulled from a segment.
   *
   * Injected rather than constructed here so segmentation, offset arithmetic,
   * date resolution and coverage accounting are all testable without a model —
   * which is what lets the invariants run on every fixture instead of only where
   * weights happen to be present.
   */
  extract?: Extractor;
}

/**
 * `build_timeline` — documents in, cited chronology out.
 *
 * Slice 1 covers segment → extract → date → cite. Reconciliation across
 * documents and support judging arrive next; until then every extracted event
 * becomes its own row, and nothing is merged, because a silent merge destroys
 * evidence and an unmerged duplicate merely looks untidy.
 */
export class BuildTimelineTool extends Tool<{ documents: EvidenceDocument[] }> {
  readonly name = 'build_timeline';
  readonly protected = false;
  // No native call, no shared-context decode — safe off the loop fiber.
  readonly fanout = true;
  readonly description =
    'Build a dated chronology from a set of documents. Returns rows with the ' +
    'exact supporting span for each claim, events that could not be dated, and ' +
    'segments that failed to process.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      documents: {
        type: 'array',
        description: 'Evidence documents with text and locator regions.',
      },
    },
    required: ['documents'],
  };

  private _locale: string;
  private _segmentChars: number;
  private _extract?: Extractor;

  constructor(opts: BuildTimelineOpts) {
    super();
    this._locale = opts.locale;
    this._segmentChars = opts.segmentChars ?? DEFAULT_SEGMENT_CHARS;
    this._extract = opts.extract;
  }

  *execute(args: { documents: EvidenceDocument[] }): Operation<unknown> {
    const documents = args.documents ?? [];
    const resolver = createDateResolver(this._locale);

    const rows: TimelineRow[] = [];
    const unresolved: TimelineRow[] = [];
    const unprocessed: TimelineResult['unprocessed'] = [];
    let segmentsSeen = 0;
    let seq = 0;

    for (const doc of documents) {
      // Fail loudly on malformed evidence at the boundary: unsorted regions
      // yield citations that are quietly wrong rather than absent.
      try {
        assertWellFormedDocument(doc);
      } catch (e) {
        unprocessed.push({
          docId: doc?.id ?? '(unknown)',
          reason: e instanceof Error ? e.message : String(e),
        });
        continue;
      }

      // A document's own date is the anchor a relative expression measures from.
      const anchors: DateAnchor[] = [];
      const docDate = doc.metadata?.createdAt ?? doc.metadata?.publishedAt;
      if (docDate) anchors.push({ id: `${doc.id}:document`, value: docDate.slice(0, 10) });

      for (const segment of segmentDocument(doc, this._segmentChars)) {
        segmentsSeen++;

        let events: ExtractedEvent[];
        try {
          // Never throw out of a segment: one malformed page must not cost the
          // other 599. The failure is recorded and the run continues.
          events = this._extract
            ? yield* this._extract(segment.text, doc.id)
            : [];
        } catch (e) {
          unprocessed.push({
            docId: doc.id,
            span: segment.span,
            reason: e instanceof Error ? e.message : String(e),
          });
          continue;
        }

        for (const event of events) {
          // Segment-local offsets become document offsets HERE, once, so every
          // span downstream is openable in the original.
          const span: [number, number] = [
            segment.span[0] + event.span[0],
            segment.span[0] + event.span[1],
          ];
          const support: AssertionSupport = {
            docId: doc.id,
            span,
            cites: resolveCites(doc, span),
          };
          const assertion: TimelineAssertion = {
            id: `a${++seq}`,
            description: event.description,
            temporalStatus: event.temporalStatus,
            epistemicStatus: event.epistemicStatus,
            polarity: event.polarity,
            ...(event.attributedTo ? { attributedTo: event.attributedTo } : {}),
            supports: [support],
          };

          const resolution = resolver.resolve(event.dateExpr, anchors);
          const row: TimelineRow = {
            id: `r${seq}`,
            date: resolution.ok ? resolution.date : null,
            assertions: [assertion],
          };
          // An undatable event is recorded, never guessed and never dropped.
          (resolution.ok ? rows : unresolved).push(row);
        }
      }
    }

    rows.sort((a, b) => {
      const byDate = (a.date?.value ?? '').localeCompare(b.date?.value ?? '');
      if (byDate !== 0) return byDate;
      return (
        (a.assertions[0]?.supports[0]?.span[0] ?? 0) -
        (b.assertions[0]?.supports[0]?.span[0] ?? 0)
      );
    });

    const result: TimelineResult = { rows, unresolved, unprocessed, segmentsSeen };
    return result;
  }
}
