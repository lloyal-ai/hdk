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
 * and needs no projector. Last, when the harness sets a share of the context
 * its attachments may fill, the media is priced exactly, before a cell is
 * spent: a prefill that overflows the context loses the whole conversation,
 * where a refusal here loses nothing.
 *
 * A refusal moves nothing; the caller says it and returns.
 *
 * @category Rig
 */
import type { Operation } from 'effection';
import { Attachments, ContextPressure, Ctx, waitUntilSettled } from '@lloyal-labs/lloyal-agents';
import { service } from './services';
import { asAttachment, materialize } from '@lloyal-labs/media';
import type { Attachment, Descriptor } from '@lloyal-labs/media';
import { buildUserDeltaMultimodal, deltaCells } from '@lloyal-labs/sdk';
import type { MultimodalInput } from '@lloyal-labs/sdk';

/** What the claims came to: the roots the run may read from, the projector
 *  inputs they make (`bitmaps`: one per marker, an image's bytes or a whole
 *  video), and the roots those inputs belong to (what the trunk records as
 *  projected); or the one sentence to say instead. */
export type Admitted =
  | { roots: Attachment[]; bitmaps: MultimodalInput[]; projected: Attachment[]; /** The projected roots that are videos. */ videos: Attachment[] }
  | { refused: string };

/** How much of the context a turn's attachments may take. */
export interface AttachmentBudget {
  /** The largest fraction of the context, in (0, 1], the turn's projected media may fill when prefilled. Unset: no limit. */
  context?: number;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function* admitted(descriptors: readonly Descriptor[] = [], budget: AttachmentBudget = {}): Operation<Admitted> {
  const { context } = budget;
  if (context !== undefined && !(context > 0 && context <= 1)) {
    throw new Error(`admitted: the attachments' context share must be between 0 and 1, not ${context}`);
  }
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
    if (context !== undefined) {
      const refusal = yield* overBudget(bitmaps, context);
      if (refusal) return { refused: refusal };
    }
  }
  return { roots, bitmaps, projected, videos };
}

/** The sentence refusing media that would fill more than `context` of the context, if it would. */
function* overBudget(bitmaps: MultimodalInput[], context: number): Operation<string | undefined> {
  const ctx = yield* Ctx.expect();
  const { nCtx } = new ContextPressure(ctx);
  if (nCtx <= 0) return undefined;
  const cells = yield* waitUntilSettled(deltaCells(ctx, buildUserDeltaMultimodal(ctx, '', bitmaps)));
  const allowed = Math.floor(nCtx * context);
  if (cells <= allowed) return undefined;
  const what = bitmaps.length === 1 ? 'That attachment' : 'Those attachments';
  return `${what} would take ${cells.toLocaleString('en-US')} of the ${nCtx.toLocaleString('en-US')}-token context; ` +
    `this harness lets attachments fill up to ${Math.round(context * 100)}% of it. Try a shorter clip or fewer attachments.`;
}
