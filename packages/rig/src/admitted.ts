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
 * materializes to pixels: a document is text the run retrieves from, and needs
 * no projector.
 *
 * A refusal moves nothing; the caller says it and returns.
 *
 * @category Rig
 */
import type { Operation } from 'effection';
import { Attachments, Ctx } from '@lloyal-labs/lloyal-agents';
import { asAttachment, materialize } from '@lloyal-labs/media';
import type { Attachment, Descriptor } from '@lloyal-labs/media';

/** What the claims came to: the roots the run may read from, the bitmaps that
 *  will reach the projector, and the roots those bitmaps belong to (what the
 *  trunk records as projected); or the one sentence to say instead. */
export type Admitted =
  | { roots: Attachment[]; bitmaps: Uint8Array[]; projected: Attachment[] }
  | { refused: string };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function* admitted(descriptors: readonly Descriptor[] = []): Operation<Admitted> {
  if (descriptors.length === 0) return { roots: [], bitmaps: [], projected: [] };

  const roots: Attachment[] = [];
  for (const d of descriptors) {
    const root = asAttachment(d);
    if (!root) return { refused: "That attachment reference isn't one the host admitted." };
    roots.push(root);
  }

  const store = yield* Attachments.expect();
  const bitmaps: Uint8Array[] = [];
  const projected: Attachment[] = [];
  try {
    for (const root of roots) {
      const own = materialize(store, [root]).bitmaps;
      if (own.length > 0) projected.push(root);
      bitmaps.push(...own);
    }
  } catch (err) {
    return { refused: `Couldn't read that attachment back: ${message(err)}` };
  }

  if (bitmaps.length > 0) {
    const ctx = yield* Ctx.expect();
    if (!ctx.supportsVision()) {
      return {
        refused: "This model can't see images — it has no vision projector. Pick a vision-capable model, or ask without the image.",
      };
    }
  }
  return { roots, bitmaps, projected };
}
