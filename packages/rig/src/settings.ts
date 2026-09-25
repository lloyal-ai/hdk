/**
 * `settings`, the one rig default: a command group over the Runner's knobs,
 * assuming nothing about a product. Three commands in place of a template's
 * eight (`set_config`, `set_ability_config`, `reload_runtime`); write your own
 * group to change any of it. Node-only: ability config carries paths, checked
 * for existence before anything persists.
 *
 * An ability's configuration persists FIRST, then enables: a save the disk
 * refuses leaves the live session untouched, and an enable that fails restores
 * every surface the command touched — the store, the live instance that was
 * disabled to make room, the saved config — and says why. Nothing about an
 * ability changes while a run is live: the run holds the abilities' tools and
 * their reranker.
 *
 * @category Rig
 */
import * as fs from 'node:fs';
import type { Operation } from 'effection';
import type { AbilityConfigStore } from './ability-config';
import type { AbilityFactory, AbilityRegistry } from './ability-types';
import type { ConfigTable } from './config';
import { isPathShaped, resolveAppConfigPaths, resolvePath } from './config-node';
import { getPath, withPath } from './config-paths';
import type { Bag } from './config-paths';
import { buildAbilityDescriptors } from './ability-descriptors';
import { abilityRequiresConfig } from './registry';
import type { BaseHarnessConfig, ConfigOriginValue, ConfigPatch, Runner } from './runner';
import type { Handlers } from './serve-commands';
import { configUpdated } from './settings-protocol';
import type { SettingsCommand, SettingsEvent } from './settings-protocol';

/** What the group is handed: what `initializeHarness` returned, the owner, and the app's declarations. */
export interface SettingsDeps<C extends BaseHarnessConfig, O extends Record<string, ConfigOriginValue>> {
  runner: Runner<C, O>;
  registry: AbilityRegistry;
  store: AbilityConfigStore;
  wire: { send(event: SettingsEvent<C, O>): Operation<void> };
  run: { readonly busy: boolean };
  /** The installed factories, so a reconfigured ability can be re-enabled by name. */
  abilities: readonly AbilityFactory[];
  /** The app's `defineConfig` table: which keys of a patch are paths. */
  config: ConfigTable;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A patch with its declared path keys resolved (`~` expanded, made absolute), at whatever depth the table
 *  declares them; `""` stays a clear. */
function resolvePatchPaths<C>(table: ConfigTable, patch: ConfigPatch<C>): ConfigPatch<C> {
  let out = patch as Bag;
  for (const [key, decl] of Object.entries(table)) {
    if (!decl.path) continue;
    const v = getPath(out, key);
    if (typeof v === 'string' && v !== '') out = withPath(out, key.split('.'), resolvePath(v));
  }
  return out as ConfigPatch<C>;
}

export function settings<C extends BaseHarnessConfig, O extends Record<string, ConfigOriginValue>>(
  deps: SettingsDeps<C, O>,
): { handlers: Handlers<SettingsCommand<C>> } {
  const { runner, registry, store, wire, run, abilities, config } = deps;
  const toast = (text: string): Operation<void> => wire.send({ type: 'ui:error', message: text });
  const announce = function* (): Operation<void> {
    yield* wire.send({ type: 'abilities:state', abilities: yield* buildAbilityDescriptors(registry, store, abilities) });
  };
  const abilityPatch = (name: string, values: Record<string, unknown>): ConfigPatch<C> =>
    ({ abilities: { [name]: values } }) as unknown as ConfigPatch<C>;

  return {
    handlers: {
      *set_config({ patch }) {
        yield* wire.send(configUpdated(runner.saveConfig(resolvePatchPaths(config, patch))));
      },

      *set_ability_config({ name, values }) {
        if (run.busy) return yield* toast("Wait for the run to finish before changing an ability's settings.");
        const patch = resolveAppConfigPaths(values);
        // A path must exist before anything persists or enables: a factory handed a
        // bad path can take the process down, and a persisted one would do so at every boot.
        const missing = Object.entries(patch).find(([k, v]) => isPathShaped(k, v) && !fs.existsSync(v));
        if (missing) return yield* toast(`${missing[0]}: path does not exist — ${String(missing[1])}`);

        // The values merge over what is stored: the interface sees config redacted to
        // key presence, so a save of the keys it knows must not drop the secret beside
        // them. `""` clears one key; `{}` clears the ability's config.
        const prior = (yield* store.get(name)) ?? null;
        const resolved: Record<string, unknown> = Object.keys(patch).length === 0 ? {} : { ...(prior ?? {}), ...patch };
        for (const [k, v] of Object.entries(resolved)) if (v === '') delete resolved[k];
        const clear = Object.keys(resolved).length === 0;
        // Persist first: a save the disk refuses throws to `onError` with the session untouched.
        const saved = runner.saveConfig(abilityPatch(name, resolved));
        yield* store.set(name, resolved);

        const factory = abilities.find((f) => f.manifest?.name === name);
        if (factory) {
          // Whether it was running is a fact of its own, read before the disable: an
          // ability enabled on its defaults has no stored config to infer it from.
          const wasEnabled = registry.stateOf(name) === 'enabled';
          if (wasEnabled) yield* registry.disable(name);
          if (clear && abilityRequiresConfig(factory)) {
            yield* store.clear(name);
          } else {
            try {
              yield* registry.enable(factory);
            } catch (err) {
              // The new config failed to enable: restore every surface this command
              // touched — the stored config, the live instance, the saved config —
              // and announce the restored state, or the interface keeps the roster
              // it was last told.
              if (prior && Object.keys(prior).length > 0) yield* store.set(name, prior);
              else yield* store.clear(name);
              // The prior config enabled before, so this is expected to hold; if it
              // cannot, the stored config is what fails and must not outlive the run.
              if (wasEnabled) { try { yield* registry.enable(factory); } catch { yield* store.clear(name); } }
              try { runner.saveConfig(abilityPatch(name, prior ?? {})); } catch { /* the toast reports the enable error */ }
              yield* announce();
              return yield* toast(`Cannot configure ${name}: ${message(err)}`);
            }
          }
        }
        yield* wire.send(configUpdated(saved));
        yield* announce();
      },

      *reload_runtime({ patch }) {
        // Only where a next launch will read it: on a served host the model is the server's, chosen
        // once at startup for every session, so ending this one would apply nothing.
        if (!runner.reloadRuntime(resolvePatchPaths(config, patch))) {
          return yield* toast('The model is chosen where this server starts, not per session — this change would apply to nothing.');
        }
        return 'exit';
      },
    },
  };
}
