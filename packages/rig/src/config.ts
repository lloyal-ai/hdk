/**
 * A harness's configuration, declared once as data: one entry per key, saying
 * where each rung reads it (`yml`, `env`, `cli`), what it must be (`oneOf`,
 * `integer`, `check`, `path`) and what stands when no rung supplies it
 * (`default`). rig/node layers `cli > env > harness.json > harness.yml >
 * default` from it, computes provenance as it goes, validates and resolves
 * paths (`@lloyal-labs/rig/node`: `loadYml`, `loadConfig`, `saveLocalConfig`,
 * `runnerConfig`). The `abilities` family is layered for every app and
 * declared by none; `version` is rig's.
 *
 * `modelSettings` is the model family — one block per model, each key at the
 * path `harness.yml` names it by — so an app spreads it and declares only its
 * own keys. Node-free: the renderer may import the table and the types it derives.
 *
 * @category Rig
 */
import type { RerankInstruction } from '@lloyal-labs/sdk';
import type { BaseHarnessConfig, ConfigOriginValue, ConfigPatch } from './runner';
import { isBag } from './config-paths';
import type { Bag } from './config-paths';

/** The shape `harness.json` is written in, and the live config carries: one block per model. A version-1
 *  file, written before alpha.10 with the model keys flat, is refused by name — nothing before the alpha is
 *  carried forward. */
export const CONFIG_VERSION = 2;

/** When a change to a key takes effect. `session`: at once, for what runs next. `reload`: it names the
 *  residency (a model, a backend), so it is saved and the next launch applies it. `boot`: it sizes the context
 *  the process already built, so only `harness.yml` and a restart change it. */
export type ConfigTier = 'session' | 'reload' | 'boot';

/** One key's declaration. Every field is optional; a key with none is a committed-only string. */
export interface ConfigKey {
  /** Where the committed rung reads it in `harness.yml`, dotted. Absent: never committed. */
  yml?: string;
  /** The environment variable that outranks both files. */
  env?: string;
  /** The name the boot's CLI overrides carry it under. */
  cli?: string;
  /** A path: `~` expanded and made absolute at the boundary, whichever rung supplied it. */
  path?: true;
  /** A positive integer; the env rung parses digits, the others refuse anything else. */
  integer?: true;
  /** The values it may take. A committed value outside them fails the load. */
  oneOf?: readonly string[];
  /** Any other rule. A committed value that fails it fails the load; a local one falls through. */
  check?: (value: unknown) => boolean;
  /** What stands when no rung supplies a value. Makes the key always present — inside a block, only once the
   *  block is: a default never requests a model. */
  default?: unknown;
  /** When a change takes effect, for whatever offers one: a `session` key is changed with `set_config`, a
   *  `reload` key with `reload_runtime`, a `boot` key not at all while running. @default 'session' */
  applies?: ConfigTier;
  /** What the key is, in one sentence, for whoever shows it. How a change applies is `applies`'s to say, and
   *  where it is set is `yml`'s, so this says neither. */
  describe?: string;
}

/** The table: config paths (dotted) to their declarations. */
export type ConfigTable = Record<string, ConfigKey>;

/** A default's literal type widens to its primitive: `default: 'reports'` declares a string, not the word. */
type Widen<X> = X extends string ? string : X extends number ? number : X extends boolean ? boolean : X;
type ValueOf<D> =
  D extends { oneOf: readonly (infer U)[] } ? U
  : D extends { integer: true } ? number
  : D extends { check: (value: unknown) => value is infer G } ? G
  : D extends { default: infer X } ? Widen<X>
  : string;

/** `a.b.c` → `{ a: { b?: { c: V } } }`: the top-level family always present, a block under it only when a rung
 *  requested it, the leaf optional unless the key has a default. */
type Leaf<K extends string, V, Required extends boolean> =
  K extends `${infer Head}.${infer Rest}` ? { [P in Head]: Block<Rest, V, Required> }
  : Required extends true ? { [P in K]: V } : { [P in K]?: V };
type Block<K extends string, V, Required extends boolean> =
  K extends `${infer Head}.${infer Rest}` ? { [P in Head]?: Block<Rest, V, Required> }
  : Required extends true ? { [P in K]: V } : { [P in K]?: V };
/** The committed shape: every level optional, since a manifest states only what it changes. */
type YmlLeaf<K extends string, V> =
  K extends `${infer Head}.${infer Rest}` ? { [P in Head]?: YmlLeaf<Rest, V> } : { [P in K]?: V };

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
type Merge<T> = T extends (...args: never[]) => unknown ? T : T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]: Merge<T[K]> } : T;

/** The resolved config a table describes: rig's families, then every declared key at its path. */
export type ConfigOf<T extends ConfigTable> = Merge<
  BaseHarnessConfig &
  UnionToIntersection<{ [K in keyof T & string]: Leaf<K, ValueOf<T[K]>, T[K] extends { default: unknown } ? true : false> }[keyof T & string]>
>;

/** Provenance: which rung supplied each declared key, by the key itself. */
export type OriginOf<T extends ConfigTable> = { [K in keyof T & string]: ConfigOriginValue };

/** The boot's CLI overrides: each key that declared a `cli` name, under that name. */
export type CliOf<T extends ConfigTable> = {
  [K in keyof T as T[K] extends { cli: infer N extends string } ? N : never]?: ValueOf<T[K]>;
};

/** What `harness.yml` may say: each key that declared a `yml` path, at that path, plus the abilities family. */
export type YmlOf<T extends ConfigTable> = Merge<
  UnionToIntersection<{ [K in keyof T & string]: T[K] extends { yml: infer Y extends string } ? YmlLeaf<Y, ValueOf<T[K]>> : never }[keyof T & string]>
  & { abilities?: Record<string, Record<string, unknown>> }
>;

/**
 * Declare a harness's configuration. Returns the table, typed, so `ConfigOf`,
 * `OriginOf`, `CliOf` and `YmlOf` can be read off it. Refuses the keys rig owns
 * (`version`, the `abilities` family) and a key that is both a leaf and a family.
 *
 * @category Rig
 */
export function defineConfig<const T extends ConfigTable>(table: T): T {
  const keys = Object.keys(table);
  for (const key of keys) {
    if (key === 'version') throw new Error(`defineConfig: \`version\` is rig's — it is always ${CONFIG_VERSION} and never declared`);
    if (key === 'abilities' || key.startsWith('abilities.')) {
      throw new Error('defineConfig: the `abilities` family is layered for every app and never declared');
    }
    const family = keys.find((other) => other !== key && key.startsWith(`${other}.`));
    if (family) throw new Error(`defineConfig: \`${family}\` is a family under \`${key}\` and cannot also be a key`);
  }
  return Object.freeze({ ...table }) as T;
}

/** The paths a table says hold keys — `model`, `model.llm`, `defaults` — and the `abilities` family rig layers
 *  for every app. Anything else a config carries is one value. */
export function configFamilies(table: ConfigTable): Set<string> {
  const families = new Set(['abilities']);
  for (const key of Object.keys(table)) {
    const segs = key.split('.');
    for (let depth = 1; depth < segs.length; depth++) families.add(segs.slice(0, depth).join('.'));
  }
  return families;
}

function mergeInto(families: Set<string>, base: Bag, patch: Bag, at: string): Bag {
  const out: Bag = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const here = at ? `${at}.${key}` : key;
    if (value === '' || value === null) delete out[key];
    else if (families.has(here) && isBag(value)) out[key] = mergeInto(families, isBag(base[key]) ? base[key] : {}, value, here);
    else out[key] = value;
  }
  return out;
}

/**
 * Merge a patch into a config by the table: a family takes the patch's keys one by one, however deep the table
 * declares it, and everything else is one value replaced whole — an object-valued key such as `defaults.guards`,
 * an ability's config, an array. `""` — or `null` — clears a key at any depth. Never mutates either side.
 *
 * @category Rig
 */
export function mergeConfig<C extends BaseHarnessConfig>(table: ConfigTable, base: C, patch: ConfigPatch<C>): C {
  const out = mergeInto(configFamilies(table), base as unknown as Bag, patch as unknown as Bag, '');
  out.version = CONFIG_VERSION;
  return out as unknown as C;
}

/** How an embedding model pools — rig's `EmbeddingPooling`, restated as the values the key takes. */
const EMBEDDING_POOLINGS = ['mean', 'cls', 'last'] as const;

/** The KV cache types the attention layers can take — the SDK's `KvCacheType`, restated so the table stays dependency-free. */
const KV_CACHE_TYPES = ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'] as const;

/** The scoring question with its canary, as the reranker takes it at load — a manifest that would fail there fails here. */
function isRerankInstruction(v: unknown): v is RerankInstruction {
  if (!isBag(v) || typeof v.text !== 'string') return false;
  const canary = v.smokeTest;
  if (canary === 'none') return true;
  return isBag(canary) && typeof canary.query === 'string' && typeof canary.matching === 'string' && typeof canary.nonMatching === 'string'
    && typeof canary.minGap === 'number' && Number.isFinite(canary.minGap) && canary.minGap >= 0;
}

/**
 * The model family: one block per model, its keys at the path `harness.yml`
 * names them by. Spread it into `defineConfig` and declare only your own keys;
 * framework knowledge is never restated per application.
 *
 * A block's presence is the request for that model and its keys are the
 * selection: `llm` is the reasoning model and its context; `reranker` the
 * pointwise judge the abilities score with; `vision` the projector that lets
 * the reasoning model see an image, paired from the catalog when the block
 * names no id; `embedding` the encoder a harness indexes with. An absent block is a decision: no request, nothing loaded — and
 * a `default:` on a tuning key stands only once the block is present, so a
 * default never requests a model. The CUDA backend pack is the box's, not a
 * key: `lloyal backends:install` puts it there.
 *
 * @category Rig
 */
export const modelSettings = defineConfig({
  'model.llm.id': { yml: 'model.llm.id', applies: 'reload', describe: 'The catalog id of the reasoning model, fetched and digest-verified before it loads.' },
  'model.llm.path': { yml: 'model.llm.path', cli: 'modelPath', path: true, applies: 'reload', describe: 'A local .gguf for the reasoning model; outranks the catalog id.' },
  'model.llm.context': { yml: 'model.llm.context', env: 'LLAMA_CTX_SIZE', cli: 'nCtx', integer: true, applies: 'boot', describe: 'The context window of the one shared llama_context; every branch leases its cells from this budget.' },
  'model.llm.gpu': { yml: 'model.llm.gpu', env: 'LLOYAL_GPU', cli: 'gpu', oneOf: ['default', 'cuda', 'vulkan'], applies: 'boot', describe: 'The native backend the process loaded. A configured backend fails loud when unavailable, never silently CPU.' },
  'model.llm.branches': { yml: 'model.llm.branches', integer: true, applies: 'boot', describe: 'How many sequences the context holds at once (nSeqMax); each holds its own KV lease.' },
  'model.llm.kvCache': { yml: 'model.llm.kvCache', oneOf: KV_CACHE_TYPES, applies: 'boot', describe: 'The KV cache type for the attention layers: higher precision costs memory, and the reranker needs it.' },
  'model.reranker.id': { yml: 'model.reranker.id', applies: 'reload', describe: 'The catalog id of the reranker — the pointwise judge that scores what the abilities retrieve.' },
  'model.reranker.path': { yml: 'model.reranker.path', cli: 'reranker', path: true, applies: 'reload', describe: 'A local .gguf for the reranker; outranks the catalog id.' },
  'model.reranker.context': { yml: 'model.reranker.context', integer: true, default: 16384, applies: 'boot', describe: 'The reranker context; every scoring sequence leases from it.' },
  'model.reranker.instruction': { yml: 'model.reranker.instruction', check: isRerankInstruction, applies: 'boot', describe: 'The scoring question and its canary — what relevant means for every ability sharing the reranker.' },
  'model.vision.id': { yml: 'model.vision.id', applies: 'reload', describe: 'The catalog id of the vision projector; unset, the one the catalog pairs with the reasoning model.' },
  'model.vision.path': { yml: 'model.vision.path', path: true, applies: 'reload', describe: 'A local .gguf for the vision projector; outranks the catalog id.' },
  'model.vision.minTokens': { yml: 'model.vision.minTokens', integer: true, applies: 'reload', describe: 'The floor on how many tokens one image is projected into; grounding tasks want it high.' },
  'model.vision.maxTokens': { yml: 'model.vision.maxTokens', integer: true, applies: 'reload', describe: 'The ceiling on what one image costs in context cells; lower it to fit more images.' },
  'model.embedding.id': { yml: 'model.embedding.id', applies: 'reload', describe: 'The catalog id of the embedding model — the encoder a harness indexes with, one vector per text.' },
  'model.embedding.path': { yml: 'model.embedding.path', path: true, applies: 'reload', describe: 'A local .gguf for the embedding model; outranks the catalog id.' },
  'model.embedding.context': { yml: 'model.embedding.context', integer: true, default: 2048, applies: 'boot', describe: 'The most tokens one text may embed as; a longer text is refused, never truncated.' },
  'model.embedding.pooling': { yml: 'model.embedding.pooling', oneOf: EMBEDDING_POOLINGS, applies: 'boot', describe: 'How the model folds token states into one vector — its own property; a catalog id carries it, a local file must say.' },
});

/** The model family as the layering resolves it: one block per model, present when a rung requested it. */
export type ModelFamily = ConfigOf<typeof modelSettings>['model'];
