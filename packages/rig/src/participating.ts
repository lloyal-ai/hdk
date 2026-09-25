/**
 * The sources a run can research with, and what each advertises.
 *
 * `abilityToc` is an ability's own content advert — one line per file for a
 * corpus, one per document for the documents ability, absent for a source that
 * advertises nothing (the web). It is keyed on the run's assets: a source that
 * reads attachments lists those; the others ignore the argument.
 *
 * `participating` is the enabled abilities minus the ones the reader switched
 * off, minus any whose catalog is EMPTY for this run — documents with none
 * attached, a corpus with no files. Such a source has nothing to research and
 * is left out, so it draws neither a coverage probe nor a planner route, and its
 * tools are not on the spine.
 *
 * @category Rig
 */
import type { Operation } from 'effection';
import { AbilityRegistryCtx } from './ability-types';
import type { Ability } from './ability-types';
import type { Attachment } from '@lloyal-labs/media';

/** An ability's `toc` prompt datum for this run's assets, or `null` when it advertises none. */
export function abilityToc(ability: Ability, attachments: readonly Attachment[] = []): string | null {
  const toc = ability.source.promptData(attachments)['toc'];
  return typeof toc === 'string' ? toc : null;
}

/** The enabled abilities that can take part in a run: not switched off (`excluded`, by manifest name), with something to read for this run. */
export function* participating(excluded: readonly string[] = [], attachments: readonly Attachment[] = []): Operation<Ability[]> {
  const registry = yield* AbilityRegistryCtx.expect();
  const off = new Set(excluded);
  return registry.enabled().filter((a) => !off.has(a.manifest.name) && abilityToc(a, attachments) !== '');
}
