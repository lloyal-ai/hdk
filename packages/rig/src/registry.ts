/**
 * `createAbilityRegistry` — harness-wide ability registry with structured,
 * **isolated** per-ability lifecycle.
 *
 * `createAbilityRegistry({ configStore, grantStore? })` returns an **empty**
 * registry; `registry.enable(factory)` is the single way to enable an ability —
 * creation is never enablement, so the two paths can't collide.
 *
 * - `registry.enable(factory)` runs the factory in its own **detached**
 *   Effection scope, seeded with the ability-facing framework contexts
 *   (`AbilityConfigStoreCtx`, `RerankerCtx`) so the factory reads config +
 *   reranker. The factory body is setup; a `resource()` factory's
 *   `ensure(...)` is teardown. Every enabled ability's scope is torn down on the
 *   registry's own scope exit, reverse enable-order, **best-effort** — a
 *   throwing teardown is logged but never strands a sibling, and never
 *   crashes the harness. The harness does **not** call a per-ability register
 *   verb at boot; it just calls `enable` for each boot ability.
 * - `registry.disable(name)` handles mid-session removal. `enable` →
 *   `'enabled'`, `disable` → `'disabled'` (matching {@link AbilityState}).
 *   `disable` swallows + logs a throwing teardown, so a mid-session
 *   uninstall can't crash the session — possible only because each ability
 *   owns a detached scope whose teardown errors don't propagate to a
 *   parent.
 *
 * There are no install/uninstall/enable/disable hooks on the Ability. A
 * factory that throws (or whose manifest fails validation) tears down its
 * partial scope and propagates; the ability never enters the registry.
 * Per-ability independent — one ability's failure can't roll back another.
 *
 * @packageDocumentation
 * @category Protocol
 */

import { call, createScope, ensure, suspend } from 'effection';
import type { Operation } from 'effection';
import {
  AbilityRegistryCtx,
  AbilityConfigStoreCtx,
  GrantStoreCtx,
  RerankerCtx,
} from '@lloyal-labs/lloyal-agents';
import type {
  Ability,
  AbilityFactory,
  AbilityRegistry,
  AbilityConfigStore,
  GrantStore,
  Reranker,
} from '@lloyal-labs/lloyal-agents';
import { SUPPORTED_ABILITY_PROTOCOL_VERSIONS } from './protocol';

/**
 * Options for {@link createAbilityRegistry}.
 */
export interface CreateAbilityRegistryOpts {
  /**
   * The harness-supplied per-ability config store. The registry sets it on
   * `AbilityConfigStoreCtx` and seeds it into each ability's scope so factories
   * read config at construction.
   */
  configStore: AbilityConfigStore;
  /**
   * The session's protected-tool grant store. The
   * registry seeds it on `GrantStoreCtx` so the agent pool's authGuard can
   * resolve which `protected` tools the session is authorized to call.
   * Optional — omit it when no ability exposes protected tools (the authGuard
   * is a no-op then). When omitted with protected tools present, the
   * authGuard fails closed (every protected tool denied).
   */
  grantStore?: GrantStore;
}

interface RegistryEntry {
  ability: Ability;
  /** Halts the ability's detached scope, firing its factory `ensure`s. */
  destroy: () => Promise<void>;
}

/**
 * Create the harness-wide ability registry.
 *
 * Sets `AbilityRegistryCtx` and `AbilityConfigStoreCtx` in the caller's scope (the
 * `initAgents` pattern). Returns an empty registry — enable the boot set with
 * explicit `registry.enable(factory)` calls. Every enabled ability's scope is torn
 * down on the caller's scope exit (reverse order, best-effort). Creation is not
 * enablement: there is one way to enable an ability, so the two paths can't collide.
 *
 * @example
 * ```ts
 * import { createWebAbility } from '@lloyal-labs/web-ability';
 * import { createCorpusAbility } from '@lloyal-labs/corpus-ability';
 *
 * yield* RerankerCtx.set(reranker);          // before, if factories read it
 * const registry = yield* createAbilityRegistry({ configStore });
 * yield* registry.enable(createWebAbility);
 * yield* registry.enable(createCorpusAbility);
 * // ... pool dispatch ...
 * // registry scope exit tears down every ability (factory ensures fire)
 * ```
 */
export function* createAbilityRegistry(
  opts: CreateAbilityRegistryOpts,
): Operation<AbilityRegistry> {
  const { configStore, grantStore } = opts;
  const entries = new Map<string, RegistryEntry>();
  const order: string[] = [];

  const registry: AbilityRegistry = {
    byName(name: string): Ability | undefined {
      return entries.get(name)?.ability;
    },
    enabled(): readonly Ability[] {
      return order.map((n) => entries.get(n)!.ability).filter(Boolean);
    },
    stateOf(name: string): 'enabled' | 'disabled' {
      return entries.has(name) ? 'enabled' : 'disabled';
    },
    *enable(factory: AbilityFactory): Operation<Ability> {
      // Read the ability-facing framework contexts to seed into the ability's
      // detached scope (factories read config + reranker).
      let reranker: Reranker | undefined;
      try {
        reranker = yield* RerankerCtx.expect();
      } catch {
        reranker = undefined;
      }

      const [scope, destroy] = createScope();
      let added = false;
      try {
        // Run the factory in a DETACHED scope (so its teardown errors stay
        // isolated and swallowable), seeded with the framework contexts.
        // It resolves the Ability out, then suspends — keeping the Ability and its
        // ensure() teardown alive until `destroy()`.
        const ability = yield* call(
          () =>
            new Promise<Ability>((resolve, reject) => {
              scope
                .run(function* () {
                  try {
                    yield* AbilityConfigStoreCtx.set(configStore);
                    yield* AbilityRegistryCtx.set(registry);
                    if (reranker !== undefined) yield* RerankerCtx.set(reranker);
                    const constructed = yield* factory();
                    resolve(constructed);
                    yield* suspend();
                  } catch (err) {
                    reject(err as Error);
                  }
                })
                .catch(() => {
                  /* halt-after-resolve rejection — expected, ignore */
                });
            }),
        );

        const declared = ability.manifest.appProtocolVersion ?? '3.0';
        if (!SUPPORTED_ABILITY_PROTOCOL_VERSIONS.includes(declared)) {
          throw new Error(
            `Ability "${ability.manifest.name}" declares appProtocolVersion="${declared}", ` +
              `but the framework supports [${SUPPORTED_ABILITY_PROTOCOL_VERSIONS.map((v) => `"${v}"`).join(', ')}]. ` +
              `Upgrade the ability or use a framework version that supports this protocol.`,
          );
        }

        const existingConfig = yield* configStore.get(ability.manifest.name);
        if (existingConfig !== undefined && ability.manifest.configSchema) {
          validateConfigShape(ability.manifest.name, existingConfig, ability.manifest.configSchema);
        }

        if (entries.has(ability.manifest.name)) {
          throw new Error(
            `Ability "${ability.manifest.name}" is already enabled. ` +
              `Call registry.disable("${ability.manifest.name}") first to replace it.`,
          );
        }

        // Namespace-collision guard. The catalog scopes abilities by handle
        // (`acme/web` vs `lloyal/web`), but the runtime/model surface is
        // UNSCOPED — `manifest.name` keys this registry, and `protocol.name` +
        // each tool name address the ability in the shared spine the model reads.
        // Two same-short-named abilities from different publishers therefore collide
        // here. The `manifest.name` check above catches one face; this catches
        // the model-facing faces (otherwise spine-render emits two CATALOG_ENTRY
        // blocks with the same protocol/tool names — silent routing ambiguity +
        // a collided BOUNDARY_MARKER). Fail loud, naming both abilities, so the
        // integrator knows it's a cross-publisher clash — not their bug.
        const incomingProtocol = ability.manifest.protocol.name;
        const incomingTools = ability.manifest.protocol.tools;
        for (const { ability: existing } of entries.values()) {
          if (existing.manifest.protocol.name === incomingProtocol) {
            throw new Error(
              `Cannot enable "${ability.manifest.name}": its protocol "${incomingProtocol}" ` +
                `collides with already-enabled "${existing.manifest.name}". Two Abilities ` +
                `can't share a model-facing protocol name in one harness — disable one, or ` +
                `use abilities with distinct protocol names.`,
            );
          }
          const clashTool = incomingTools.find((t) =>
            existing.manifest.protocol.tools.includes(t),
          );
          if (clashTool !== undefined) {
            throw new Error(
              `Cannot enable "${ability.manifest.name}": its tool "${clashTool}" collides with ` +
                `already-enabled "${existing.manifest.name}". Two Abilities can't share a ` +
                `tool name in one harness — disable one, or use abilities with distinct tool names.`,
            );
          }
        }

        entries.set(ability.manifest.name, { ability, destroy });
        order.push(ability.manifest.name);
        added = true;
        return ability;
      } finally {
        // Factory threw, validation failed, or the caller was halted before
        // the ability entered the registry → tear down its detached scope
        // (best-effort; don't mask the original error).
        if (!added) {
          try {
            yield* call(() => destroy());
          } catch {
            /* teardown error on the failure path — original error wins */
          }
        }
      }
    },
    *disable(name: string): Operation<void> {
      const entry = entries.get(name);
      if (!entry) return;
      entries.delete(name);
      const idx = order.indexOf(name);
      if (idx >= 0) order.splice(idx, 1);
      try {
        yield* call(() => entry.destroy());
      } catch (err) {
        console.error(
          `[lloyal-rig] teardown for ability "${name}" threw during disable — ability removed regardless:`,
          err,
        );
      }
    },
  };

  yield* AbilityRegistryCtx.set(registry);
  yield* AbilityConfigStoreCtx.set(configStore);
  // Seed the grant store so the agent pool's authGuard can
  // read the session's protected-tool grants. Absent = fail-closed.
  if (grantStore) yield* GrantStoreCtx.set(grantStore);

  // Tear down every still-enabled ability on registry scope exit, reverse
  // register-order, best-effort (a throwing teardown is logged, never
  // strands a sibling, never crashes the harness). Registered before the
  // boot set so a mid-boot failure still cleans up the abilities that enabled.
  yield* ensure(function* () {
    for (let i = order.length - 1; i >= 0; i--) {
      const name = order[i];
      const entry = entries.get(name);
      if (!entry) continue;
      try {
        yield* call(() => entry.destroy());
      } catch (err) {
        console.error(
          `[lloyal-rig] teardown for ability "${name}" threw — continuing teardown:`,
          err,
        );
      }
    }
    entries.clear();
    order.length = 0;
  });

  return registry;
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Minimal structural schema check. Validates that every property in
 * `schema.required` exists on `config` with a type compatible with
 * `schema.properties[name].type`. This is a guardrail — the framework
 * does not ship a full JSON Schema validator. Abilities requiring richer
 * validation should run their own check in the factory body.
 */
function validateConfigShape(
  abilityName: string,
  config: Record<string, unknown>,
  schema: { type?: string; required?: readonly string[] | string[]; properties?: Record<string, unknown> },
): void {
  if (schema.type && schema.type !== 'object') {
    return; // non-object schemas are out of scope for the guardrail
  }
  for (const key of schema.required ?? []) {
    if (!(key in config)) {
      throw new Error(
        `Ability "${abilityName}" stored config is missing required key "${key}" ` +
          `declared in manifest.configSchema. Re-run the ability's config flow or clear stale config.`,
      );
    }
  }
  for (const [key, rawPropSchema] of Object.entries(schema.properties ?? {})) {
    if (!(key in config)) continue;
    const propSchema = rawPropSchema as { type?: unknown } | null | undefined;
    if (!propSchema || typeof propSchema.type !== 'string') continue;
    const value = config[key];
    if (!matchesPrimitiveType(value, propSchema.type)) {
      throw new Error(
        `Ability "${abilityName}" stored config key "${key}" has type "${typeof value}" ` +
          `but manifest.configSchema declares "${propSchema.type}". ` +
          `Re-run the ability's config flow or clear stale config.`,
      );
    }
  }
}

function matchesPrimitiveType(value: unknown, declared: string): boolean {
  switch (declared) {
    case 'string':
      return typeof value === 'string';
    case 'number':
    case 'integer':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}
