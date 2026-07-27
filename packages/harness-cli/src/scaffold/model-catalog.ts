/**
 * A minimal, vendored copy of `@lloyal-labs/rig`'s model catalog — just the
 * fields the interactive `new` model picker needs (`id` / `role` / `label` /
 * `recommendedContext`), NOT the download URLs or digests (rig owns fetching +
 * verification; the CLI only offers the choice).
 *
 * It is vendored, not imported, on purpose: the catalog is only exported from
 * `@lloyal-labs/rig/node`, whose barrel also pulls in `createReranker` (the
 * NATIVE `@lloyal-labs/lloyal.node`) + the App registry. `harness.dev` is the
 * Apache-2.0, zero-native-dep CLI — `verify.ts` duplicates rig's verify surface
 * for exactly this reason. Keep these rows in sync with rig's `MODEL_CATALOG`
 * (packages/rig/src/models.ts); adding a row here only widens the picker.
 */

export type ModelRole = 'llm' | 'reranker';

export interface CatalogModel {
  /** Stable id — what gets written into `harness.yml` `model.<role>.id`. */
  id: string;
  role: ModelRole;
  /** Human label for the picker row. */
  label: string;
  /** Suggested `context` (nCtx) — written alongside an `llm` choice. */
  recommendedContext?: number;
}

/** Mirrors `@lloyal-labs/rig`'s `MODEL_CATALOG`, minus urls/sha256/sizeBytes. */
export const MODEL_CATALOG: readonly CatalogModel[] = [
  {
    id: 'reasoning-4b',
    role: 'llm',
    label: 'Reasoning 4B · Q4_K_M',
    recommendedContext: 32768,
  },
  {
    id: 'qwen3-reranker-0.6b-q8',
    role: 'reranker',
    label: 'Qwen3 Reranker 0.6B · Q8_0',
  },
];

/** The catalog entries for one role, in listing order. */
export function modelsForRole(role: ModelRole): readonly CatalogModel[] {
  return MODEL_CATALOG.filter((m) => m.role === role);
}
