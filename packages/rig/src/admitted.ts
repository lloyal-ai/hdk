/**
 * `admitted(descriptors)` — the wire's attachment claims, checked once, for
 * every product.
 *
 * A descriptor arrives from a client as JSON: a claim about content, not a
 * fact about it. Three questions, in order, and they are different questions.
 * `asAttachment` asks whether a descriptor is even the kind of thing that can
 * be a root — cheap, and it refuses a client that sends a representation digest
 * hoping it gets expanded as one. `materialize` asks the store whether the
 * content is really there, which is the question no client can answer for
 * itself and the one a forged descriptor fails. Sight is asked for only by what
 * materializes to pixels — of the `vision` service, so the refusal is the one
 * every unconfigured service gives: a document is text the run retrieves from,
 * and needs no projector.
 *
 * A refusal moves nothing; the caller says it and returns.
 *
 * @category Rig
 */
import type { Operation } from 'effection';
import { Attachments } from '@lloyal-labs/lloyal-agents';
import { service } from './services';
import { asAttachment, materialize } from '@lloyal-labs/media';
import type { Attachment, Descriptor } from '@lloyal-labs/media';
import type { MultimodalInput } from '@lloyal-labs/sdk';

/** What the claims came to: the roots the run may read from, the projector
 *  inputs they make (`bitmaps`: one per marker, an image's bytes or a whole
 *  video), and the roots those inputs belong to (what the trunk records as
 *  projected); or the one sentence to say instead. */
export type Admitted =
  | { roots: Attachment[]; bitmaps: MultimodalInput[]; projected: Attachment[]; /** The projected roots that are videos. */ videos: Attachment[] }
  | { refused: string };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function* admitted(descriptors: readonly Descriptor[] = []): Operation<Admitted> {
  if (descriptors.length === 0) return { roots: [], bitmaps: [], projected: [], videos: [] };

  const roots: Attachment[] = [];
  for (const d of descriptors) {
    const root = asAttachment(d);
    if (!root) return { refused: "That attachment reference isn't one the host admitted." };
    roots.push(root);
  }

  const store = yield* Attachments.expect();
  const bitmaps: MultimodalInput[] = [];
  const projected: Attachment[] = [];
  const videos: Attachment[] = [];
  try {
    for (const root of roots) {
      const own = materialize(store, [root]).inputs;
      if (own.length > 0) projected.push(root);
      if (own.some((input) => !(input instanceof Uint8Array) && input.kind === 'video')) videos.push(root);
      bitmaps.push(...own);
    }
  } catch (err) {
    return { refused: `Couldn't read that attachment back: ${message(err)}` };
  }

  if (bitmaps.length > 0) {
    try {
      yield* service('vision');
    } catch (err) {
      return { refused: message(err) };
    }
  }
  return { roots, bitmaps, projected, videos };
}
