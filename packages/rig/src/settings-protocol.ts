/**
 * The vocabulary rig owns on the wire: the run controls every product's brief
 * or sheet handles, the three settings commands rig's `settings` group serves,
 * and what it says back. An application's `Command` and event unions include
 * these beside their own words. Node-free.
 *
 * @category Rig
 */
import type { AbilityDescriptor } from './ability-descriptors';
import { redactAbilityConfig } from './ability-descriptors';
import type { BaseHarnessConfig, ConfigOriginValue, ConfigPatch, SaveResult } from './runner';

/** The controls of the live run — handled by the product part that owns the execution owner. */
export type RunCommand =
  | { type: 'stop' }
  | { type: 'wrap_up' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'cancel_agent'; agentId: number };

/** The Runner's knobs: three commands in place of a template's eight. */
export type SettingsCommand<C extends BaseHarnessConfig = BaseHarnessConfig> =
  /** A live setting: one-level-deep, only the keys that change (`saveConfig`). */
  | { type: 'set_config'; patch: ConfigPatch<C> }
  /** One ability's stored config, whole-replaced; `{}` clears it. */
  | { type: 'set_ability_config'; name: string; values: Record<string, unknown> }
  /** A residency setting (model, reranker, gpu, image tokens): persisted, then the harness ends and the next launch applies it. */
  | { type: 'reload_runtime'; patch: ConfigPatch<C> };

/** What rig says about configuration. Ability values are redacted to key presence on every event: on a served placement the wire ends in every tenant's renderer. */
export type SettingsEvent<C extends BaseHarnessConfig = BaseHarnessConfig, O = Record<string, ConfigOriginValue>> =
  /** The first event on the wire: the resolved config, its provenance, and whether this is a dev boot. */
  | { type: 'config:loaded'; config: C; origin: O; path?: string; dev: boolean }
  /** A save landed: the re-layered config and provenance, and where it was written (`null`: in memory). */
  | { type: 'config:updated'; config: C; origin: O; savedTo: string | null; gitignored: boolean; skipped: string[] }
  /** Every installed ability, enabled or not, with its config redacted to key presence. */
  | { type: 'abilities:state'; abilities: AbilityDescriptor[] }
  /** A toast — one meaning only, never an abort. */
  | { type: 'ui:error'; message: string };

/** The `config:loaded` event for a runner. */
export function configLoaded<C extends BaseHarnessConfig, O>(runner: { config(): C; origin(): O; dev: boolean }): SettingsEvent<C, O> {
  return { type: 'config:loaded', config: redactAbilityConfig(runner.config()), origin: runner.origin(), dev: runner.dev };
}

/** The `config:updated` event for a save. Redaction lives in the builder, so forgetting it is unrepresentable. */
export function configUpdated<C extends BaseHarnessConfig, O>(saved: SaveResult & { config: C; origin: O }): SettingsEvent<C, O> {
  return { type: 'config:updated', config: redactAbilityConfig(saved.config), origin: saved.origin, savedTo: saved.path, gitignored: saved.gitignored, skipped: saved.skipped };
}
