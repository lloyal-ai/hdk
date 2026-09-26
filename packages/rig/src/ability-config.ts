/**
 * `AbilityConfigStore` — pluggable per-ability config storage.
 *
 * The interface and its context ({@link AbilityConfigStoreCtx}) live together here; the
 * concrete in-memory implementation is `createInMemoryConfigStore`, and a harness may
 * supply its own backend.
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
 * @category Rig
 */

import { createContext } from 'effection';
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

/**
 * Effection context holding the harness's {@link AbilityConfigStore}.
 *
 * Set by `createAbilityRegistry({ configStore })` from its `configStore` option, and seeded into each
 * ability's detached scope so factories can read it: `(yield* AbilityConfigStoreCtx.expect()).get(manifest.name)`
 * at construction time. The framework validates the stored config against `ability.manifest.configSchema`
 * when the ability is enabled. Whole-replace semantics on `set`; last-write-wins on concurrent writes.
 *
 * @category Rig
 */
export const AbilityConfigStoreCtx = createContext<AbilityConfigStore>('lloyal.abilityConfigStore');
