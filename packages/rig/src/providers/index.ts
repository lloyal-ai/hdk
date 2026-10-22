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
import type { ModelRole, ModelSpec } from '../models';
import type { Service, ServiceMap, Trunk } from '../services';
import { catalogEntry } from '../models';
import type { EmbeddingPooling } from '../retrieval';
import { createReranker } from './reranker';
import { createEmbedder } from './embedding';
import { createTranscriber } from './transcription';

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
  bind?(artifact: string, block: ModelBlock<K>, projector?: string): Operation<ServiceMap[K]>;
  /** A companion projector acquired through the same verified model resolver. `select` answers nothing when the
   *  model chosen has no projector, and refuses when it needs one that nothing names. */
  projector?: {
    role: Exclude<ModelRole, 'llm' | Service>;
    name: string;
    select(block: ModelBlock<K>): ModelSpec | undefined;
  };
  /** The options the artifact contributes to the resident context — for a service that is a capability of the
   *  trunk. `service(name)` then answers the {@link Trunk} marker. */
  trunk?: ServiceMap[K] extends Trunk ? (artifact: string, block: ModelBlock<K>) => Partial<ContextOptions> : never;
  /** Why a block that selects a model still cannot be bound — a tuning the row needs that neither the block nor
   *  the catalog says — said at plan time, before a byte is fetched or the trunk loads. Nothing to say: `undefined`. */
  refuse?(block: ModelBlock<K>): string | undefined;
}

export const providers: { [K in Service]: ProviderRow<K> } = {
  transcription: {
    name: 'transcription model',
    projector: {
      role: 'transcription.projector', name: 'audio projector',
      select: block => pairedProjector('transcription', 'audio projector', block)
        ?? fail('set model.transcription.projector.id or model.transcription.projector.path; no audio projector follows from this decoder'),
    },
    bind: (artifact, block, projector) => {
      if (!projector) throw new Error('transcription requires its audio projector');
      return createTranscriber(artifact, projector, block);
    },
  },
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
    // One space for text, images, video and sound, so what a harness saw and what it heard are searched alike.
    derive: () => ({ id: 'embeddinggemma-2-q8' }),
    projector: { role: 'embedding.projector', name: 'embedding projector', select: block => pairedProjector('embedding', 'embedding projector', block) },
    refuse: (block) => {
      const binding = embeddingBinding(block);
      return 'refused' in binding ? binding.refused : undefined;
    },
    bind: (artifact, block, projector) => {
      const binding = embeddingBinding(block);
      if ('refused' in binding) throw new Error(binding.refused);
      const { framing, dimensions } = catalogedEmbedding(block) ?? {};
      return createEmbedder(artifact, {
        nCtx: block.context, pooling: binding.pooling, ...(framing ? { framing } : {}), ...(dimensions ? { dimensions } : {}),
        ...(projector ? { projector, imageMinTokens: block.vision?.minTokens, imageMaxTokens: block.vision?.maxTokens } : {}),
      });
    },
  },
};

const fail = (why: string): never => { throw new Error(why); };

/**
 * The projector a service's model is paired with: an explicit path; else an explicit id, which for a catalog
 * model must be the catalog's own pair; else the catalog's pair. Nothing when the model has none. A `path:`
 * model is bytes the catalog knows nothing about, so it is never paired from the id it shadows.
 */
function pairedProjector(service: 'transcription' | 'embedding', name: string, block: { id?: string; path?: string; projector?: ModelSpec }): ModelSpec | undefined {
  const explicit = block.projector;
  if (explicit?.path) return { path: explicit.path };
  const paired = block.path || !block.id ? undefined : catalogEntry(service, block.id)?.projector;
  if (explicit?.id) {
    if (!catalogEntry(`${service}.projector`, explicit.id) || (paired && paired !== explicit.id)) {
      fail(`model.${service}.projector.id does not name a compatible ${name}; use a matching catalog pair or explicit local paths`);
    }
    return { id: explicit.id };
  }
  return paired ? { id: paired } : undefined;
}

const UNKNOWN_POOLING = '`model.embedding` names a model whose pooling the catalog does not know — set `model.embedding.pooling` (mean, cls or last) in harness.yml';

/** What the catalog knows of the embedding model a block names by id. A `path:` model is the harness's own,
 *  and the catalog knows nothing of it. */
const catalogedEmbedding = (block: ModelBlock<'embedding'>) => (block.path || !block.id ? undefined : catalogEntry('embedding', block.id));

/** The embedding block as it binds, its pooling, or the first reason it cannot: each rule is checked at plan time,
 *  before a byte is fetched, and again at bind. */
function embeddingBinding(block: ModelBlock<'embedding'>): { pooling: EmbeddingPooling } | { refused: string } {
  const pooling = embeddingPooling(block);
  if (typeof pooling !== 'string') return { refused: pooling?.refused ?? UNKNOWN_POOLING };
  const refused = contextRefusal(block) ?? imageDetailRefusal(block);
  return refused ? { refused } : { pooling };
}

/** A catalog model reads no more than it was trained to: a longer context answers vectors the model never learned
 *  to make. A `path:` model's file is the harness's to know. */
function contextRefusal(block: ModelBlock<'embedding'>): string | undefined {
  const trained = catalogedEmbedding(block)?.trainedContext;
  const context: number | undefined = block.context;
  if (trained === undefined || context === undefined || context <= trained) return undefined;
  return `\`model.embedding.context\` is ${context}, but ${block.id} was trained to read at most ${trained} tokens — lower it to ${trained} or less`;
}

/** Image detail is the projector's: set where no projector reads it, it would be silently ignored; outside the
 *  range a catalog projector was trained for, the runtime would take it as given. */
function imageDetailRefusal(block: ModelBlock<'embedding'>): string | undefined {
  const { minTokens, maxTokens } = block.vision ?? {};
  if (minTokens === undefined && maxTokens === undefined) return undefined;
  const projector = pairedProjector('embedding', 'embedding projector', block);
  if (!projector) return `\`model.embedding.vision\` sets image detail, but ${block.id ?? block.path} has no projector to read images — remove it, or set \`model.embedding.projector\``;
  if (minTokens !== undefined && maxTokens !== undefined && minTokens > maxTokens) {
    return `\`model.embedding.vision.minTokens\` (${minTokens}) is above \`model.embedding.vision.maxTokens\` (${maxTokens})`;
  }
  const range = projector.id ? catalogEntry('embedding.projector', projector.id)?.imageTokens : undefined;
  if (!range) return undefined;
  const outside = (['minTokens', 'maxTokens'] as const).find((key) => {
    const tokens = block.vision?.[key];
    return tokens !== undefined && (tokens < range.min || tokens > range.max);
  });
  return outside ? `\`model.embedding.vision.${outside}\` is ${block.vision?.[outside]}, but ${projector.id} reads an image as ${range.min} to ${range.max} tokens — set it within that range` : undefined;
}

/**
 * How the embedding model pools, or why the block cannot say. A catalog id pools the way the catalog says:
 * a block that says otherwise is refused naming both, since a wrong pooling answers vectors that are merely
 * wrong and neither word may silently win. A `path:` model, or an id the catalog lacks, must say for itself.
 * A string is the pooling; a refusal is `{ refused }`; `undefined` is a block with nothing to say.
 */
function embeddingPooling(block: ModelBlock<'embedding'>): EmbeddingPooling | { refused: string } | undefined {
  const known = catalogedEmbedding(block)?.pooling;
  if (known && block.pooling && block.pooling !== known) {
    return { refused: `\`model.embedding.pooling\` says ${block.pooling}, but the catalog pools ${block.id} by ${known} — remove the key, or use a \`path\` for a model that pools differently` };
  }
  return known ?? block.pooling;
}
