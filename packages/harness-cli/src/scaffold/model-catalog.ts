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
    id: 'qwen3.5-4b',
    role: 'llm',
    label: 'Qwen3.5 4B · Q4_K_M',
    recommendedContext: 32768,
  },
  {
    id: 'qwen3-reranker-0.6b-q8',
    role: 'reranker',
    label: 'Qwen3 Reranker 0.6B · Q8_0',
  },
];

/**
 * One-line hardware floor, shown at the moment the model is chosen.
 *
 * Grounded, not guessed: `qwen3.5-4b` Q4_K_M is 2.6 GB of weights and the
 * `research` template adds the 0.6B reranker at 630 MB (`sizeBytes` in rig's
 * `MODEL_CATALOG`, packages/rig/src/models.ts). The rest of the 16 GB covers KV
 * at the recommended 32k context plus the OS and whichever surface is running —
 * 8 GB does not survive Electron or a browser on top. 16 GB is the machine the
 * `research` template was verified end-to-end on (Apple M2, 16 GB).
 *
 * The second sentence is the counter-intuitive part and the reason this exists:
 * readers assume four agents means four times the model. They share one
 * context, so the cost tracks KV FULLNESS, not agent count.
 */
export const MODEL_FOOTPRINT_HINT =
  '~2.6 GB download · 16 GB RAM recommended. Concurrent agents share one context — they do not multiply it.';

/** The catalog entries for one role, in listing order. */
export function modelsForRole(role: ModelRole): readonly CatalogModel[] {
  return MODEL_CATALOG.filter((m) => m.role === role);
}
