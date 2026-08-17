import { Source } from '@lloyal-labs/lloyal-agents';
import type { Tool } from '@lloyal-labs/lloyal-agents';
import { BuildTimelineTool } from './tools/build-timeline';

/**
 * The chronology source.
 *
 * Holds no corpus of its own — the harness supplies `EvidenceDocument`s, because
 * the domain owns where records live and how they are fetched. A casework
 * harness reads a matter folder, a clinical one reads an export, and neither
 * wants this package's opinion about storage.
 *
 * That is also what keeps the Ability domain-general: what counts as an event
 * arrives as configured `criteria`, not as code here.
 */
export class TimelineSource extends Source {
  readonly name = 'timeline';

  private _tools: Tool[];

  constructor(opts: TimelineSourceOpts) {
    super();
    this._tools = [
      new BuildTimelineTool({
        locale: opts.locale,
        segmentChars: opts.segmentChars,
      }),
    ];
  }

  get tools(): Tool[] {
    return this._tools;
  }
}

/** Configuration for {@link TimelineSource}. */
export interface TimelineSourceOpts {
  /**
   * BCP-47 locale selecting the date parser. Required — `03/04/24` is 3 April
   * under en-GB and 4 March under en-US.
   */
  locale: string;
  /** Target segment size in characters. Defaults to `DEFAULT_SEGMENT_CHARS`. */
  segmentChars?: number;
}
