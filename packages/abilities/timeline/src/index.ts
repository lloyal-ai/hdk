/**
 * `@lloyal-labs/timeline-ability` — documents in, cited chronology out.
 *
 * Turns records and transcripts into a dated sequence where every row carries
 * the span that supports it, so a caseworker, clinician, paralegal or adviser
 * can open the page rather than take the model's word for it. Partial dates stay
 * partial, undated events stay visible, and a segment that fails to process is
 * reported rather than dropped.
 *
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AbilityConfigStoreCtx,
  renderTemplate,
  type AbilityManifest,
  type AgentRenderCtx,
} from '@lloyal-labs/lloyal-agents';
import { defineAbility } from '@lloyal-labs/rig';
import { TimelineSource } from './source';

export { TimelineSource } from './source';
export type { TimelineSourceOpts } from './source';
export { segmentDocument, DEFAULT_SEGMENT_CHARS } from './segment';
export type { TimelineSegment } from './segment';
export { createDateResolver, ChronoDateResolver } from './dates';
export type { DateResolver, DateExpr, NormalisedDate } from './dates';
export type {
  TimelineResult,
  TimelineRow,
  TimelineAssertion,
  AssertionSupport,
} from './types';

const dir = join(__dirname, '..');
const manifest = JSON.parse(
  readFileSync(join(dir, 'ability.json'), 'utf8'),
) as AbilityManifest;
const skillTemplate = readFileSync(join(dir, 'skill.eta'), 'utf8');

/**
 * What counts as an event, when the harness has not said.
 *
 * Deliberately generic — the domain belongs in config, not in this package. A
 * casework harness means something different by "event" than a tax harness, and
 * the Ability has no business guessing which.
 */
const DEFAULT_CRITERIA =
  'Anything that happened, was scheduled, fell due, took effect, or was ' +
  'cancelled, and that a reader would expect to see placed in time.';

/**
 * Construct the timeline ability.
 *
 * `locale` is REQUIRED and has no default: `03/04/24` is April 3rd under en-GB
 * and March 4th under en-US, and guessing produces a chronology that is wrong by
 * a year without ever looking wrong. Failing at enable() is the cheaper error.
 */
export const createTimelineAbility = defineAbility(manifest, function* () {
  const cfgStore = yield* AbilityConfigStoreCtx.expect();
  const cfg = (yield* cfgStore.get('timeline')) ?? {};

  const locale = typeof cfg.locale === 'string' ? cfg.locale : undefined;
  if (!locale) {
    throw new Error(
      'createTimelineAbility: missing config `locale` (e.g. "en-GB", "en-US"). ' +
        'It has no default because 03/04/24 differs by a year between locales, ' +
        'and a chronology that is silently wrong is worse than one that refuses ' +
        'to start. Set it via the harness config store under the "timeline" key.',
    );
  }

  const criteria =
    typeof cfg.criteria === 'string' && cfg.criteria.trim().length > 0
      ? cfg.criteria.trim()
      : DEFAULT_CRITERIA;
  const segmentChars =
    typeof cfg.segmentChars === 'number' ? cfg.segmentChars : undefined;

  const source = new TimelineSource({ locale, segmentChars });

  return {
    source,
    // Keyed by tool name — the keys must equal manifest.protocol.tools as a
    // set, so building the record from the source's own tools keeps the two in
    // step rather than restating the list here.
    tools: Object.fromEntries(source.tools.map((t) => [t.name, t])),
    /**
     * A FUNCTION, not the raw template.
     *
     * `criteria` is the domain's definition of an event and the most
     * load-bearing line in the skill. It is not part of `AgentRenderCtx`, so a
     * string template referencing `it.criteria` would render it as empty
     * whenever the harness did not happen to merge it — losing the instruction
     * silently, which is precisely the failure mode this ability exists to
     * avoid. Closing over it at construction makes that unrepresentable.
     */
    skill: ((params: AgentRenderCtx) =>
      renderTemplate(skillTemplate, {
        ...params,
        criteria,
      })) satisfies (params: AgentRenderCtx) => string,
  };
});
