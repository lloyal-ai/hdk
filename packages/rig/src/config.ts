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
 * `modelSettings` is the model block with its yml, env and cli names, so an
 * app spreads it and declares only its own keys. Node-free: the renderer may
 * import the table and the types it derives.
 *
 * @category Rig
 */
import type { BaseHarnessConfig, ConfigOriginValue } from './runner';

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
  /** What stands when no rung supplies a value. Makes the key always present. */
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

/** `a.b.c` → `{ a: { b: { c: V } } }`; the leaf optional unless the key has a default, the families always present. */
type Leaf<K extends string, V, Required extends boolean> =
  K extends `${infer Head}.${infer Rest}` ? { [P in Head]: Leaf<Rest, V, Required> }
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
    if (key === 'version') throw new Error('defineConfig: `version` is rig\'s — it is always 1 and never declared');
    if (key === 'abilities' || key.startsWith('abilities.')) {
      throw new Error('defineConfig: the `abilities` family is layered for every app and never declared');
    }
    const family = keys.find((other) => other !== key && key.startsWith(`${other}.`));
    if (family) throw new Error(`defineConfig: \`${family}\` is a family under \`${key}\` and cannot also be a key`);
  }
  return Object.freeze({ ...table }) as T;
}

/** The KV cache types the attention layers can take — the SDK's `KvCacheType`, restated so the table stays dependency-free. */
const KV_CACHE_TYPES = ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'] as const;

/**
 * The model block: the keys every boot reads to build the resident context, with
 * their yml, env and cli names. Spread it into `defineConfig` and declare only
 * your own keys; framework knowledge is never restated per application.
 *
 * `id`/`path` name the reasoning model (a catalog id, or a file); `reranker`/`rerankerId`
 * the reranker the abilities score with; `nCtx`, `branches` (`nSeqMax`) and `kvCache`
 * size the context; `gpu` names the backend the process loaded; `mmproj` and the image token bounds
 * govern vision; `backendPack` records a declined pack offer.
 *
 * @category Rig
 */
export const modelSettings = defineConfig({
  'model.id': { yml: 'model.llm.id', applies: 'reload', describe: 'The catalog id of the reasoning model, fetched and digest-verified before it loads.' },
  'model.path': { yml: 'model.llm.path', cli: 'modelPath', path: true, applies: 'reload', describe: 'A local .gguf for the reasoning model; outranks the catalog id.' },
  'model.reranker': { yml: 'model.reranker.path', cli: 'reranker', path: true, applies: 'reload', describe: 'A local .gguf for the reranker — the pointwise judge that scores what the abilities retrieve.' },
  'model.rerankerId': { yml: 'model.reranker.id', applies: 'reload', describe: 'The catalog id of the reranker.' },
  'model.nCtx': { yml: 'model.llm.context', env: 'LLAMA_CTX_SIZE', cli: 'nCtx', integer: true, applies: 'boot', describe: 'The context window of the one shared llama_context; every branch leases its cells from this budget.' },
  'model.gpu': { yml: 'model.llm.gpu', env: 'LLOYAL_GPU', cli: 'gpu', oneOf: ['default', 'cuda', 'vulkan'], applies: 'boot', describe: 'The native backend the process loaded. A configured backend fails loud when unavailable, never silently CPU.' },
  'model.branches': { yml: 'model.llm.branches', integer: true, applies: 'boot', describe: 'How many sequences the context holds at once (nSeqMax); each holds its own KV lease.' },
  'model.kvCache': { yml: 'model.llm.kvCache', oneOf: KV_CACHE_TYPES, applies: 'boot', describe: 'The KV cache type for the attention layers: higher precision costs memory, and the reranker needs it.' },
  'model.imageMinTokens': { yml: 'model.llm.imageMinTokens', integer: true, applies: 'reload', describe: 'The floor on how many tokens one image is projected into; grounding tasks want it high.' },
  'model.imageMaxTokens': { yml: 'model.llm.imageMaxTokens', integer: true, applies: 'reload', describe: 'The ceiling on what one image costs in context cells; lower it to fit more images.' },
  'model.mmproj': { yml: 'model.llm.mmproj', applies: 'reload', describe: 'The vision projector for the reasoning model, so it can see an image.' },
  'model.backendPack': { check: (v: unknown): v is false => v === false, applies: 'boot', describe: 'False once a native backend pack was offered and declined, so the offer is not repeated.' },
});
