/**
 * The provider table: one row per name in `ServiceMap`, each written from the contract alone. A row says how
 * its artifact reaches the run — `bind` yields an instance of its own, `trunk` contributes options to the
 * resident context — and, where a block can mean something without naming a model, how the model is derived.
 * Its keys live in `modelSettings` as `model.<name>.*`, and its block reaches the row typed from them. The
 * framework resolves the artifact into `models/<name>/`, binds or folds each present block in the owning
 * scope, and seeds the result into every ability scope — a contributor never sees that walk.
 *
 * Every row is here, in one screen; a binding that reaches the native runtime is its own file beside this one
 * (`reranker.ts`, `embedding.ts`). Node-only. Import from `@lloyal-labs/rig/node`.
 *
 * @category Rig
 */
import type { Operation } from 'effection';
import type { ContextOptions } from '@lloyal-labs/sdk';
import type { ModelFamily } from '../config';
import type { ModelSpec } from '../models';
import type { Service, ServiceMap, Trunk } from '../services';
import { catalogEntry } from '../models';
import type { EmbeddingPooling } from '../retrieval';
import { createReranker } from './reranker';
import { createEmbedder } from './embedding';

/** A service's block as the layering resolved it — its selection and its tuning, typed from `modelSettings`. */
export type ModelBlock<K extends Service> = NonNullable<ModelFamily[K]>;

/** What a contributor writes for a service. */
export interface ProviderRow<K extends Service> {
  /** What a reader calls the thing this row acquires — "the reranker", "the vision projector" — as the install
   *  names its step. Framework words for what the model IS, never the harness's. */
  name: string;
  /** Which model backs it when the block names none — only a row with a derivation has one. `undefined`
   *  refuses, naming `model.<name>.id`. */
  derive?(of: { llm: { id?: string; path?: string } }): ModelSpec | undefined;
  /** Bind the artifact — the model file in the service's slot — as the instance `service(name)` answers. A
   *  `resource()`: the instance lives as long as the scope that bound it. */
  bind?(artifact: string, block: ModelBlock<K>): Operation<ServiceMap[K]>;
  /** The options the artifact contributes to the resident context — for a service that is a capability of the
   *  trunk. `service(name)` then answers the {@link Trunk} marker. */
  trunk?: ServiceMap[K] extends Trunk ? (artifact: string, block: ModelBlock<K>) => Partial<ContextOptions> : never;
  /** Why a block that selects a model still cannot be bound — a tuning the row needs that neither the block nor
   *  the catalog says — said at plan time, before a byte is fetched or the trunk loads. Nothing to say: `undefined`. */
  refuse?(block: ModelBlock<K>): string | undefined;
}

export const providers: { [K in Service]: ProviderRow<K> } = {
  reranker: {
    name: 'reranker',
    bind: (artifact, block) => createReranker(artifact, { nCtx: block.context, instruction: block.instruction }),
  },
  vision: {
    name: 'vision projector',
    // One vision tower serves every quant of the same model, so the catalog's pairing stands in for an id. A
    // `path:` llm is bytes the catalog knows nothing about, and a projector inferred from its id would load for
    // a model that is not running.
    derive: ({ llm }) => {
      if (llm.path || !llm.id) return undefined;
      const paired = catalogEntry('llm', llm.id)?.vision;
      return paired ? { id: paired } : undefined;
    },
    trunk: (artifact, block) => ({ mmprojPath: artifact, imageMinTokens: block.minTokens, imageMaxTokens: block.maxTokens }),
  },
  embedding: {
    name: 'embedding model',
    refuse: (block) => (embeddingPooling(block) ? undefined : UNKNOWN_POOLING),
    bind: (artifact, block) => {
      const pooling = embeddingPooling(block);
      if (!pooling) throw new Error(UNKNOWN_POOLING);
      return createEmbedder(artifact, { nCtx: block.context, pooling });
    },
  },
};

const UNKNOWN_POOLING = '`model.embedding` names a model whose pooling the catalog does not know — set `model.embedding.pooling` (mean, cls or last) in harness.yml';

/** How the embedding model pools: the block's own word, else the catalog's for its id. A `path:` model the
 *  catalog knows nothing about must say, because a wrong pooling answers vectors that are merely wrong. */
function embeddingPooling(block: ModelBlock<'embedding'>): EmbeddingPooling | undefined {
  if (block.pooling) return block.pooling;
  return block.path || !block.id ? undefined : catalogEntry('embedding', block.id)?.pooling;
}
