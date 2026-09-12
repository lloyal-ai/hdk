/**
 * @file Where a project keeps its content — policy, not format.
 *
 * The OCI layout itself lives in `@lloyal-labs/media/node`, beside the format
 * it implements. What stays here is the one decision a harness owns: which
 * directory a project's media lands in. Splitting them is what makes that
 * boundary visible rather than arguable — the layout is a published spec and
 * moves rarely; where a project puts its files is template vocabulary.
 */
import { FileAttachmentStore } from '@lloyal-labs/media/node';
import type { AttachmentStore } from '@lloyal-labs/media';
import { join } from 'node:path';

/** Where a project keeps its media, relative to the project root. */
export const MEDIA_DIR = 'media';

/**
 * Open a project's content store — the OCI Image Layout at `<root>/media/`.
 *
 * Separate from {@link useTraceWriter} because the two differ in every
 * dimension that matters, and bundling them behind one directory and one flag
 * hid that:
 *
 * | | location | gated | lifetime |
 * |---|---|---|---|
 * | trace | `sources.outputDir` | `LLOYAL_DEV` | one per session |
 * | content | `<root>/media/` | never | durable, project-scoped |
 *
 * **Never dev-gated**, because addressability is a REPLAY requirement rather
 * than telemetry: media that reaches the cache unaddressed produces a run that
 * cannot be rebuilt. `media/` sits beside `models/` — its precedent — and NOT
 * under `sources.outputDir`, which is where run OUTPUT goes while media is
 * INPUT, and which may point outside the project entirely.
 *
 * **Call this ONCE per process** and share the instance: a served host builds
 * it alongside the host and injects it into every materialised Session. One
 * object, not one per Session pointing at the same directory. The store's
 * index commit is synchronous, so sharing is hygiene rather than a race fix —
 * but keeping it synchronous is what makes that true.
 *
 * @param projectRoot - Where `harness.yml` was found. NOT `process.cwd()`,
 *                      which is wherever the operator happened to start.
 *
 * @category Runtime
 */
export function createProjectMediaStore(projectRoot: string): AttachmentStore {
  return new FileAttachmentStore(join(projectRoot, MEDIA_DIR));
}
