/**
 * The embedding provider's binding: a model file becomes an {@link Embedder} on a context of its own.
 *
 * The runtime's encoder takes one input whole — every token and every piece of media into one sequence from
 * position zero, and an input longer than the batch is refused rather than truncated — so an embedder is a
 * serial discipline over that context: clear, encode, read, one input at a time, one caller at a time.
 * Concurrency is not batching here; it is a queue, and the queue spans callers, because two interleaved
 * clear/encode/read sequences answer wrong vectors silently.
 *
 * An input is text and attachment roots in order. Each root becomes what the projector reads (an image's
 * pixels, a recording's samples, a video's frames on their timeline and, when the model hears, its soundtrack
 * window by window), with a media marker where each stands in
 * the text; its text is framed as the model asks for its task; and the whole input is measured before any of
 * it runs.
 *
 * Node-only. Import from `@lloyal-labs/rig/node`.
 */
import { createContext } from '@lloyal-labs/sdk/node';
import { buildEmbedDelta, embedCells, embedDelta, mediaKind, PoolingType } from '@lloyal-labs/sdk';
import type { AudioLimits, MultimodalDelta, MultimodalInput, SessionContext } from '@lloyal-labs/sdk';
import { AUDIO_CONFIG_TYPE, audioAdmission, audioLimitsAt, materialize } from '@lloyal-labs/media';
import type { AudioAdmission } from '@lloyal-labs/media';
import type { Attachment, AttachmentStore } from '@lloyal-labs/media';
import { call, ensure, resource, until } from 'effection';
import { acquire } from '../acquire';
import { RunnerCtx } from '../runner';
import type { Operation } from 'effection';
import type { Embedder, EmbeddingFraming, EmbeddingInput, EmbeddingPooling, EmbeddingTask, Modality } from '../retrieval';

/** What the embedding block decides about its context. */
export interface EmbedderLoadOpts {
  /** The most tokens one text may embed as — the context and the batch are both this, since a text is
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
  /** Where attachment parts are read from; the run's own store when absent. */
  store?: AttachmentStore;
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

/** Why a root gave the projector nothing: a recording the model cannot hear, or a document, whose text is not an
 *  image. Either is refused rather than left out of the vector unseen. */
function unread(store: AttachmentStore, part: Attachment, i: number, j: number): Error {
  return store.getManifest(part.digest)?.config.mediaType === AUDIO_CONFIG_TYPE
    ? new Error(`input ${i} part ${j} is a recording, and this embedding model does not hear — set \`model.embedding.projector\` to a projector that hears`)
    : new Error(`input ${i} part ${j} has nothing the projector reads — embed its text as a text part`);
}

/** One input as the context takes it: its framing, then each part, a root becoming what the projector reads (a
 *  video's soundtrack too, when the model hears, under `heard`), built as the SDK builds an embedding input. */
function place(
  store: AttachmentStore | undefined, framing: EmbeddingFraming, heard: { admission: AudioAdmission; limits: AudioLimits } | undefined,
  input: EmbeddingInput, i: number,
): MultimodalDelta {
  const parts = partsOf(input).flatMap((part, j): (string | MultimodalInput)[] => {
    if (typeof part === 'string') return [part];
    if (!store) throw new Error('an attachment part needs the attachment store, and none is in reach');
    const media = materialize(store, [part], heard ? { audio: heard.admission } : {}).inputs as MultimodalInput[];
    if (media.length === 0) throw unread(store, part, i, j);
    return media;
  });
  return buildEmbedDelta([framingOf(framing, input, i), ...parts], heard ? { audioLimits: heard.limits } : {});
}

const POOLING: Record<EmbeddingPooling, PoolingType> = { mean: PoolingType.MEAN, cls: PoolingType.CLS, last: PoolingType.LAST };

/**
 * Create an {@link Embedder} backed by a dedicated embedding context, as an Effection `resource()`: it lives
 * as long as the scope that bound it, and the context is freed only once every encode already submitted to
 * the native runtime has settled — a cancelled wait on the JS side proves nothing about a worker mid-flight.
 * A caller's `dispose()` is the same release, earlier: the scope's exit then finds nothing left to free.
 *
 * @category Rig
 */
export function createEmbedder(modelPath: string, opts: EmbedderLoadOpts): Operation<Embedder> {
  return resource(function* (provide) {
    const nCtx = opts.nCtx ?? 2048;
    // Owned from the request: a halt while the model loads still frees the context when it arrives. One free,
    // whichever comes first — a caller's `dispose()` once the queue drains, or the scope's exit.
    const free = (c: SessionContext): Promise<void> => c.dispose();
    const framing = opts.framing ?? {};
    const ctx = yield* acquire(
      () => createContext({
        modelPath, nCtx, nBatch: nCtx, nSeqMax: 1, embeddings: true, poolingType: POOLING[opts.pooling],
        ...(opts.projector ? { mmprojPath: opts.projector, imageMinTokens: opts.imageMinTokens, imageMaxTokens: opts.imageMaxTokens } : {}),
      }),
      free,
    );

    // The one queue EVERY call joins — tokenize as much as embed, since both reach the native context — refused
    // once disposed. `settled` is the tail: what teardown waits for.
    let settled: Promise<unknown> = Promise.resolve();
    let disposed = false;
    const serialized = <T>(work: () => Promise<T>): Promise<T> => {
      if (disposed) return Promise.reject(new Error('the embedder is disposed'));
      const next = settled.then(work, work);
      settled = next.then(() => undefined, () => undefined);
      return next;
    };

    const dimension = ctx.getEmbeddingDimension();
    const dimensions = [...(opts.dimensions ?? [dimension])].sort((a, b) => b - a);
    if (dimensions[0] !== dimension) {
      throw new Error(`the embedding model answers ${dimension} dimensions, but its catalog entry was trained to ${dimensions.join(', ')}`);
    }

    // What the bound model reads: text always, and what its projector, if any, reads.
    const modalities: Modality[] = [
      'text',
      ...(ctx.supportsVision() ? (['image', 'video'] as const) : []),
      ...(ctx.supportsAudio() ? (['audio'] as const) : []),
    ];
    const heard = ctx.supportsAudio()
      ? { admission: RECORDING_ADMISSION, limits: audioLimitsAt(RECORDING_ADMISSION, ctx.audioSampleRate()) }
      : undefined;

    /** Every input placed and measured, with nothing run; the whole call refused at the first input the model
     *  cannot read. */
    const admit = async (store: AttachmentStore | undefined, inputs: readonly EmbeddingInput[]) => {
      const deltas = inputs.map((input, i) => place(store, framing, heard, input, i));
      deltas.forEach(({ bitmaps }, i) => {
        const unread = bitmaps.map(mediaKind).find((m) => !modalities.includes(m));
        if (unread) {
          throw new Error(`input ${i} has an ${unread}, which this embedding model cannot read — set \`model.embedding.projector\` to a projector that reads it`);
        }
      });
      const measured: { delta: MultimodalDelta; cells: number }[] = [];
      for (const delta of deltas) measured.push({ delta, cells: await embedCells(ctx, delta) });
      return measured;
    };

    /** The store attachment parts are read from: the one given, or the run's own. None is needed for text. */
    function* storeFor(inputs: readonly EmbeddingInput[]): Operation<AttachmentStore | undefined> {
      const hasMedia = inputs.some((input) => partsOf(input).some((part) => typeof part !== 'string'));
      return hasMedia ? opts.store ?? (yield* RunnerCtx.expect()).attachmentStore : undefined;
    }

    // The queue is the adapter over the native calls, the way `call` is over `fetch`; what a caller holds is an
    // Operation, so leaving a scope abandons the wait while the queue behind it still drains.
    const embedder: Embedder = {
      dimension,
      dimensions,
      modalities,
      audio: heard?.admission ?? null,
      tasks: Object.keys(framing) as EmbeddingTask[],
      // The model's own special tokens, as its file declares them: last-token pooling reads the end-of-text token
      // such a model appends, and the runtime's default tokenize adds a leading token only.
      tokenize: (text) => call(() => serialized(() => ctx.tokenize(text, true))),
      *measure(inputs) {
        const store = yield* storeFor(inputs);
        return yield* call(() => serialized(async () => (await admit(store, inputs)).map((p) => p.cells)));
      },
      *embed(inputs) {
        const store = yield* storeFor(inputs);
        return yield* call(() => serialized(async () => {
          // Measure first, run second: an input over the context is refused with nothing touched, so the call
          // after it finds the context exactly as it was.
          const admitted = await admit(store, inputs);
          admitted.forEach(({ cells }, i) => {
            if (cells > nCtx) throw new Error(`input ${i} is ${cells} cells; \`model.embedding.context\` is ${nCtx} — shorten it or raise the context`);
          });
          // Work once admitted runs whole: the free waits on this queue's tail, so a dispose mid-batch cannot
          // pull the context from under it, and a caller is never answered half a batch.
          const out: Float32Array[] = [];
          for (const { delta } of admitted) out.push(await embedDelta(ctx, delta));
          return out;
        }));
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        // The release its contract promises: no new work from here, and the context freed once the work in
        // flight has settled — never under a native call. The tail is fixed now, since nothing joins the queue
        // after this line.
        const drained = settled;
        void drained.then(() => free(ctx), () => free(ctx));
      },
    };

    // The scope's exit does the same — stop taking work, let the queue drain — and frees what a caller has not
    // already; registered after the acquisition, so it runs before the context is freed. `ensure` rather than
    // `finally`: a `yield*` inside a finally loses a halt.
    yield* ensure(function* () {
      embedder.dispose();
      yield* until(settled);
    });
    yield* provide(embedder);
  });
}
