/**
 * `AbilityConfigStore` — pluggable per-ability config storage.
 *
 * The interface lives in `@lloyal-labs/lloyal-agents` so the framework
 * context (`AbilityConfigStoreCtx`) and ability factories (in `@lloyal-labs/rig`,
 * `@lloyal-labs/web-ability`, `@lloyal-labs/corpus-ability`) share a common type
 * without a dependency cycle. The concrete in-memory implementation
 * (`createInMemoryConfigStore`) and harness-supplied backends live in
 * rig and harness packages.
 *
 * **Semantics:**
 *
 * - **Whole-replace `set`.** The second arg replaces existing config
 *   wholesale; abilities that need merge do read-modify-write themselves.
 * - **Last-write-wins on concurrent writes.** Two parallel
 *   `set(abilityName, ...)` calls race; whichever lands second overwrites.
 * - **Framework validates stored config against `ability.manifest.configSchema`**
 *   when the ability is enabled (`createAbilityRegistry({ abilities })` /
 *   `registry.enable`), after the factory constructs the manifest. The
 *   store interface is pure storage — it does not know about the manifest.
 *
 * @packageDocumentation
 * @category Contract
 */

import type { Operation } from 'effection';

/**
 * Pluggable per-ability config storage interface.
 *
 * All methods return `Operation<...>` (Effection generators) so concrete
 * implementations can perform async IO (file reads, remote KV calls)
 * inside the framework's scope.
 */
export interface AbilityConfigStore {
  /**
   * Read the current config for an ability. Returns `undefined` if no
   * config has been set for this ability name.
   */
  get(abilityName: string): Operation<Record<string, unknown> | undefined>;
  /**
   * Whole-replace the config for an ability. Concurrent writes are
   * last-write-wins.
   */
  set(abilityName: string, config: Record<string, unknown>): Operation<void>;
  /**
   * Remove the config for an ability entirely (sets back to `undefined`
   * state). Idempotent — clearing a never-set ability is a no-op.
   */
  clear(abilityName: string): Operation<void>;
}
