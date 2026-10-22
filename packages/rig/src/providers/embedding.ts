/**
 * The embedding provider's binding: a model file becomes an {@link Embedder} on a service context of its own.
 *
 * The runtime's encoder takes one input whole — every token and every piece of media into one sequence from
 * position zero, and an input longer than the batch is refused rather than truncated — so every call is one unit
 * on that context: clear, encode, read, one input after another, one caller after another. Two interleaved
 * clear/encode/read sequences would answer each other's vectors.
 *
 * An input is text and attachment roots in order. Each root becomes what the projector reads (an image's
 * pixels, a recording's samples, a video's frames on their timeline and, when the model hears, its soundtrack
 * window by window), with a media marker where each stands in the text; its text is framed as the model asks for
 * its task; and the whole input is measured before any of it runs.
 *
 * Node-only. Import from `@lloyal-labs/rig/node`.
 */
import { buildEmbedDelta, embedCells, embedDelta, mediaKind, PoolingType } from '@lloyal-labs/sdk';
import type { AudioLimits, MultimodalDelta, MultimodalInput } from '@lloyal-labs/sdk';
import { audioAdmission, audioLimitsAt, materialize } from '@lloyal-labs/media';
import type { AudioAdmission } from '@lloyal-labs/media';
import type { Attachment, AttachmentStore } from '@lloyal-labs/media';
import { resource } from 'effection';
import { Attachments, waitUntilSettled } from '@lloyal-labs/lloyal-agents';
import { useServiceContext } from './service-context';
import type { Operation } from 'effection';
import type { Embedder, EmbeddingFraming, EmbeddingInput, EmbeddingPooling, EmbeddingTask, Modality } from '../retrieval';

/** What the embedding block decides about its context. */
export interface EmbedderLoadOpts {
  /** The most cells one input may embed as — the context and the batch are both this, since an input is
   *  encoded whole. Default 2048. */
  nCtx?: number;
  /** How the model pools its token states. The model's own property: the catalog says it for an id, a
   *  `path:` model must say it in `model.embedding.pooling`. */
  pooling: EmbeddingPooling;
  /** The projector a multimodal embedding model reads images, video and sound through, loaded on the same
   *  context. Absent for a text-only model. */
  projector?: string;
  /** The floor and ceiling on the tokens the projector reads one image or frame as; the projector's own when absent. */
  imageMinTokens?: number;
  imageMaxTokens?: number;
  /** The model's own text for each task it was trained for, from its catalog entry. Absent, text is embedded
   *  as given and no task can be asked for. */
  framing?: EmbeddingFraming;
  /** The widths the model was trained to be cut to, from its catalog entry. Absent, its own width alone. */
  dimensions?: readonly number[];
}

const partsOf = (input: EmbeddingInput): readonly (string | Attachment)[] => (typeof input === 'string' ? [input] : input.parts);

/** `a`, `a and b`, `a, b and c`. */
const listed = (names: readonly string[]): string =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** The text a model's framing puts before an input: its task's framing for its role, with its title where the task
 *  has a place for one. Media alone goes unframed, as the cards say; a model with no framing embeds text as given,
 *  so only an input that names a task asks it for one. */
function framingOf(framing: EmbeddingFraming, input: EmbeddingInput, i: number): string {
  const { task, role = 'document', title } = typeof input === 'string' ? {} : input;
  const tasks = Object.keys(framing);
  if (tasks.length === 0 && task === undefined) return '';
  const asked: EmbeddingTask = task ?? 'search';
  const frame = framing[asked];
  if (!frame) {
    const offered = tasks.length ? `frames ${listed(tasks)}` : 'frames no task';
    throw new Error(`input ${i} is for ${asked}; the bound embedding model ${offered} — set \`model.embedding\` to a model that frames it`);
  }
  if (!partsOf(input).some((part) => typeof part === 'string')) return '';
  if (role === 'query') return frame.query;
  return title !== undefined && frame.titled ? frame.titled.replace('{title}', () => title) : frame.document;
}

/** The admission a recording meets to be embedded: media's default. The context bounds what an input costs;
 *  this bounds only what the native decoder may take before the input is measured. */
const RECORDING_ADMISSION = audioAdmission();

/** What the bound model reads through its projector: whether it sees, and the admission and native limits it hears
 *  sound under, when it hears. */
interface Reads {
  sees: boolean;
  heard?: { admission: AudioAdmission; limits: AudioLimits };
}

/** What a root is that the bound model cannot read: why `materialize` gave the projector nothing, or the kind of
 *  input it gave that the model does not see. */
type Unread = 'unheard' | 'text' | 'image' | 'video';

/** The one refusal of a root the model cannot read, by what it is. Refused rather than left out of the vector unseen. */
const UNREAD: Record<Unread, string> = {
  unheard: 'is a recording, and this embedding model does not hear — set `model.embedding.projector` to a projector that hears',
  image: 'is an image, and this embedding model does not see — set `model.embedding.projector` to a projector that sees',
  video: 'is a video, and this embedding model does not see — set `model.embedding.projector` to a projector that sees',
  text: 'has nothing the projector reads — embed its text as a text part',
};

/** The first thing in a root's materialization the model cannot read, if any. */
function unreadOf(reads: Reads, skipped: readonly { reason: 'unheard' | 'text' }[], inputs: readonly MultimodalInput[]): Unread | undefined {
  const unseen = reads.sees ? [] : inputs.map(mediaKind).filter((kind): kind is 'image' | 'video' => kind !== 'audio');
  return [...skipped.map((s) => s.reason), ...unseen][0];
}

/** One input as the context takes it: its framing, then each part, a root becoming what the projector reads (a
 *  video's soundtrack too, when the model hears), built as the SDK builds an embedding input. */
function place(store: AttachmentStore, framing: EmbeddingFraming, reads: Reads, input: EmbeddingInput, i: number): MultimodalDelta {
  const parts = partsOf(input).flatMap((part, j): (string | MultimodalInput)[] => {
    if (typeof part === 'string') return [part];
    const { inputs, skipped } = materialize(store, [part], reads.heard ? { audio: reads.heard.admission } : {});
    const unread = unreadOf(reads, skipped, inputs);
    if (unread) throw new Error(`input ${i} part ${j} ${UNREAD[unread]}`);
    return inputs as MultimodalInput[];
  });
  return buildEmbedDelta([framingOf(framing, input, i), ...parts], reads.heard ? { audioLimits: reads.heard.limits } : {});
}

const POOLING: Record<EmbeddingPooling, PoolingType> = { mean: PoolingType.MEAN, cls: PoolingType.CLS, last: PoolingType.LAST };

/**
 * Create an {@link Embedder} on a service context of its own, as an Effection `resource()`: it lives as long as
 * the scope that bound it, and the context is freed with that scope once the call running has finished.
 *
 * @category Rig
 */
export function createEmbedder(modelPath: string, opts: EmbedderLoadOpts): Operation<Embedder> {
  return resource(function* (provide) {
    const nCtx = opts.nCtx ?? 2048;
    const framing = opts.framing ?? {};
    const service = yield* useServiceContext({
      modelPath, nCtx, nBatch: nCtx, nSeqMax: 1, embeddings: true, poolingType: POOLING[opts.pooling],
      ...(opts.projector ? { mmprojPath: opts.projector, imageMinTokens: opts.imageMinTokens, imageMaxTokens: opts.imageMaxTokens } : {}),
    });
    const model = yield* service.run(function* (ctx) {
      return { dimension: ctx.getEmbeddingDimension(), sees: ctx.supportsVision(), sampleRate: ctx.supportsAudio() ? ctx.audioSampleRate() : 0 };
    });

    const dimensions = [...(opts.dimensions ?? [model.dimension])].sort((a, b) => b - a);
    if (dimensions[0] !== model.dimension) {
      throw new Error(`the embedding model answers ${model.dimension} dimensions, but its catalog entry was trained to ${dimensions.join(', ')}`);
    }

    const reads: Reads = {
      sees: model.sees,
      ...(model.sampleRate > 0 ? { heard: { admission: RECORDING_ADMISSION, limits: audioLimitsAt(RECORDING_ADMISSION, model.sampleRate) } } : {}),
    };
    const modalities: Modality[] = [
      'text',
      ...(reads.sees ? (['image', 'video'] as const) : []),
      ...(reads.heard ? (['audio'] as const) : []),
    ];

    /** Every input placed and measured, with nothing run; the whole call refused at the first input the model
     *  cannot read. */
    function* admit(inputs: readonly EmbeddingInput[]) {
      const store = yield* Attachments.expect();
      const deltas = inputs.map((input, i) => place(store, framing, reads, input, i));
      return yield* service.run(function* (ctx) {
        const measured: { delta: MultimodalDelta; cells: number }[] = [];
        for (const delta of deltas) measured.push({ delta, cells: yield* waitUntilSettled(embedCells(ctx, delta)) });
        return measured;
      });
    }

    yield* provide({
      dimension: model.dimension,
      dimensions,
      modalities,
      audio: reads.heard?.admission ?? null,
      tasks: Object.keys(framing) as EmbeddingTask[],
      // The model's own special tokens, as its file declares them: last-token pooling reads the end-of-text token
      // such a model appends, and the runtime's default tokenize adds a leading token only.
      tokenize: (text) => service.run((ctx) => waitUntilSettled(ctx.tokenize(text, true))),
      *measure(inputs) {
        return (yield* admit(inputs)).map((p) => p.cells);
      },
      *embed(inputs) {
        // Measure first, run second: an input over the context is refused with nothing touched, so the call after
        // it finds the context exactly as it was.
        const admitted = yield* admit(inputs);
        admitted.forEach(({ cells }, i) => {
          if (cells > nCtx) throw new Error(`input ${i} is ${cells} cells; \`model.embedding.context\` is ${nCtx} — shorten it or raise the context`);
        });
        return yield* service.run(function* (ctx) {
          const out: Float32Array[] = [];
          for (const { delta } of admitted) out.push(yield* waitUntilSettled(embedDelta(ctx, delta)));
          return out;
        });
      },
    });
  });
}
