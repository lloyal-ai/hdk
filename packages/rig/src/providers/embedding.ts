/**
 * The embedding provider's binding: a model file becomes an {@link Embedder} on a context of its own.
 *
 * The runtime's encoder is single-text by construction — every token goes into one sequence from position
 * zero, and a text longer than the batch is refused rather than truncated — so an embedder is a serial
 * discipline over that context: clear, encode, read, one text at a time, one caller at a time. Concurrency
 * is not batching here; it is a queue, and the queue spans callers, because two interleaved clear/encode/read
 * sequences answer wrong vectors silently.
 *
 * Node-only. Import from `@lloyal-labs/rig/node`.
 */
import { createContext } from '@lloyal-labs/lloyal.node';
import { PoolingType } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';
import { call, ensure, resource } from 'effection';
import type { Operation } from 'effection';
import type { Embedder, EmbeddingPooling } from '../retrieval';

/** What the embedding block decides about its context. */
export interface EmbedderLoadOpts {
  /** The most tokens one text may embed as — the context and the batch are both this, since a text is
   *  encoded whole. Default 2048. */
  nCtx?: number;
  /** How the model pools its token states. The model's own property: the catalog says it for an id, a
   *  `path:` model must say it in `model.embedding.pooling`. */
  pooling: EmbeddingPooling;
}

const POOLING: Record<EmbeddingPooling, PoolingType> = { mean: PoolingType.MEAN, cls: PoolingType.CLS, last: PoolingType.LAST };

/**
 * Create an {@link Embedder} backed by a dedicated embedding context, as an Effection `resource()`: it lives
 * as long as the scope that bound it, and the context is freed only once every encode already submitted to
 * the native runtime has settled — a cancelled wait on the JS side proves nothing about a worker mid-flight.
 *
 * @category Rig
 */
export function createEmbedder(modelPath: string, opts: EmbedderLoadOpts): Operation<Embedder> {
  return resource(function* (provide) {
    const nCtx = opts.nCtx ?? 2048;
    const ctx = yield* call(() => createContext({
      modelPath,
      nCtx,
      nBatch: nCtx,
      nSeqMax: 1,
      embeddings: true,
      poolingType: POOLING[opts.pooling],
    }) as Promise<SessionContext>);

    // The one queue every call joins. `settled` is the tail: what teardown waits for.
    let settled: Promise<unknown> = Promise.resolve();
    let disposed = false;
    const serialized = <T>(work: () => Promise<T>): Promise<T> => {
      const next = settled.then(work, work);
      settled = next.then(() => undefined, () => undefined);
      return next;
    };

    // The queue is the adapter over the native calls, the way `call` is over `fetch`; what a caller holds is an
    // Operation, so leaving a scope abandons the wait while the queue behind it still drains.
    const embedder: Embedder = {
      dimension: ctx.getEmbeddingDimension(),
      // The model's own special tokens, as its file declares them: last-token pooling reads the end-of-text token
      // Qwen3-Embedding appends, and the runtime's default tokenize adds a leading token only.
      tokenize: (text) => call(() => ctx.tokenize(text, true)),
      embed: (texts) => call(() => {
        if (disposed) return Promise.reject(new Error('the embedder is disposed'));
        return serialized(async () => {
          // Measure first, run second: an oversized text is refused with nothing touched, so the call after
          // it finds the context exactly as it was.
          const tokenized = await Promise.all(texts.map((t) => ctx.tokenize(t, true)));
          for (let i = 0; i < tokenized.length; i++) {
            if (tokenized[i].length > nCtx) {
              throw new Error(`text ${i} is ${tokenized[i].length} tokens; \`model.embedding.context\` is ${nCtx} — shorten the text or raise the context`);
            }
          }
          const out: Float32Array[] = [];
          for (const tokens of tokenized) {
            if (disposed) throw new Error('the embedder is disposed');
            await ctx.kvCacheClear();
            await ctx.encode(tokens);
            out.push(new Float32Array(ctx.getEmbeddings(true)));
          }
          return out;
        });
      }),
      dispose() {
        disposed = true;
      },
    };

    // Stop taking work at once; free the context only after the queue drains. `ensure` rather than `finally`:
    // a `yield*` inside a finally loses a halt.
    yield* ensure(function* () {
      embedder.dispose();
      yield* call(() => settled);
      try { ctx.dispose(); } catch { /* the context is gone either way */ }
    });
    yield* provide(embedder);
  });
}
