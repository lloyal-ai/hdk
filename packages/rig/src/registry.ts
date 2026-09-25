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
 *   (`AbilityConfigStoreCtx`, the bound services) so the factory reads config +
 *   the services it declared. The factory body is setup; a `resource()` factory's
 *   `ensure(...)` is teardown. Every enabled ability's scope is torn down on the
 *   registry's own scope exit, reverse enable-order, **best-effort** — a
 *   throwing teardown is logged but never strands a sibling, and never
 *   crashes the harness. The harness does **not** call a per-ability register
 *   verb at boot; it just calls `enable` for each boot ability.
 * - A name resolves to ONE handle for the registry's life; every enable of that name registers a new
 *   ENTRY and points the handle at it. Enabling a name already enabled supersedes it: the new entry is
 *   registered first, then the name resolves to it, and the one it replaces leaves the roster without ending
 *   while a scope holds it — a run that captured the handle spreads the new tools at its next take, and an
 *   agent that spread the old ones keeps them. `registry.disable(name)` retires the same way.
 * - A scope that took its sources through `participating()` holds their NAMES for its own life: every entry
 *   enabled under a held name, then or by any save meanwhile, outlives the scope, since its handle may be
 *   dereferenced at any time while it lives. A retired entry ends the moment nothing holds it — at retirement,
 *   or at the last release — best-effort: a throwing teardown is logged, never strands a sibling, never crashes
 *   the session. Nobody is asked whether a run is live.
 *
 * There are no install/uninstall/enable/disable hooks on the Ability. A
 * factory that throws (or whose manifest fails validation) tears down its
 * partial scope and propagates; the ability never enters the registry.
 * Per-ability independent — one ability's failure can't roll back another.
 *
 * @packageDocumentation
 * @category Protocol
 */

import { call, createScope, ensure, scoped, suspend } from 'effection';
import type { Operation } from 'effection';
import { GrantStoreCtx, Attachments } from '@lloyal-labs/lloyal-agents';
import { AbilityRegistryCtx } from './ability-types';
import { AbilityConfigStoreCtx } from './ability-config';
import { SERVICES, Services } from './services';
import type { Service, ServiceMap } from './services';

/** The requirement, held to the bag: every service a manifest declares is bound, or the ability is refused
 *  naming the block whose presence would bind it — or, for a name no row provides, saying so. The one check,
 *  run on the static manifest before the factory and on the manifest the factory returns. */
function requireBound(bound: Partial<ServiceMap> | undefined, ability: string, services: readonly string[] | undefined): void {
  for (const name of services ?? []) {
    if (!(SERVICES as readonly string[]).includes(name)) {
      throw new Error(`${ability} requires \`${name}\`, which is not a service this platform provides`);
    }
    if (!bound?.[name as Service]) {
      throw new Error(`${ability} requires \`${name}\`, which is not configured — add \`model.${name}\` to harness.yml`);
    }
  }
}
import type { GrantStore } from '@lloyal-labs/lloyal-agents';
import type { Ability, AbilityFactory, AbilityRegistry } from './ability-types';
import type { AbilityConfigStore } from './ability-config';
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

/** One scope's hold on the names it took through `participating()`: an identity, nothing more. */
type Hold = object;

/** One enable of an ability: the instance, the end of its detached scope, and who still holds it. */
interface RegistryEntry {
  name: string;
  ability: Ability;
  /** Halts the ability's detached scope, firing its factory `ensure`s. */
  destroy: () => Promise<void>;
  /** The holds open on this entry's NAME when it was enabled, less those released since: a scope that took
   *  the name may dereference its handle at any time while it lives, so every entry enabled under the name
   *  meanwhile is the scope's to hold. */
  holders: Set<Hold>;
  /** Left the roster — superseded or disabled. Ends when `holders` empties. */
  retired: boolean;
}

/** What `participating()` reaches, beside the public registry: the hold a scope takes on the names it was handed. */
const internals = new WeakMap<AbilityRegistry, { hold(names: readonly string[]): Operation<void> }>();

/**
 * Hold the named abilities for the calling scope: no entry of those names — the ones enabled now, or any a
 * save enables meanwhile — ends before that scope does. Only what the scope took: a name it left out is not
 * held, and a save or a disable under the run replaces it at once. Registered as an `ensure` in the caller —
 * a run's own operation — so a Stop, a replacement or a return releases it. A registry this module did not
 * create holds nothing.
 */
export function* holdAbilities(registry: AbilityRegistry, names: readonly string[]): Operation<void> {
  const own = internals.get(registry);
  if (own) yield* own.hold(names);
}

/**
 * The one object a name resolves to for the registry's life — what a run captures at frame time — forwarding
 * to the entry the last enable registered. A holder that dereferenced it (an agent that spread its `tools`
 * at spawn) keeps what it took; the next dereference sees the current entry. A value a tool reads at the
 * call — its ability's stored config — follows the store, not the entry: that is how a save reaches an agent
 * mid-run, and it is the ability's to read there.
 */
class Handle implements Ability {
  private target: Ability;
  constructor(readonly name: string, target: Ability) {
    this.target = target;
  }
  rebind(target: Ability): void {
    this.target = target;
  }
  get manifest(): Ability['manifest'] { return this.target.manifest; }
  get source(): Ability['source'] { return this.target.source; }
  get tools(): Ability['tools'] { return this.target.tools; }
  get skill(): Ability['skill'] { return this.target.skill; }
  get examples(): Ability['examples'] { return this.target.examples; }
  get configSchema(): Ability['configSchema'] { return this.target.configSchema; }
  get hints(): Ability['hints'] { return this.target.hints; }
  get configFlow(): Ability['configFlow'] { return this.target.configFlow; }
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
 * yield* bindServices(artifacts, model);     // before, if factories read a service
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
  /** The entry serving each enabled name — the roster. */
  const current = new Map<string, RegistryEntry>();
  /** One handle per name for the registry's life, whether or not the name is enabled right now. */
  const handles = new Map<string, Handle>();
  /** Entries that left the roster while a scope still held their name: they end at the last release, or at
   *  the registry's exit, whichever comes first. */
  const lingering = new Set<RegistryEntry>();
  /** The holds open on each name, whether or not the name is enabled right now. */
  const holdsOn = new Map<string, Set<Hold>>();
  const order: string[] = [];

  const end = function* (entry: RegistryEntry, when: string): Operation<void> {
    lingering.delete(entry);
    try {
      yield* call(() => entry.destroy());
    } catch (err) {
      console.error(`[lloyal-rig] teardown for ability "${entry.name}" threw ${when} — continuing:`, err);
    }
  };
  /** An entry leaves the roster: it ends now if nothing holds it, else when its last holder releases. */
  const retire = function* (entry: RegistryEntry): Operation<void> {
    entry.retired = true;
    if (entry.holders.size === 0) yield* end(entry, 'on retirement');
    else lingering.add(entry);
  };

  const registry: AbilityRegistry = {
    byName(name: string): Ability | undefined {
      return current.has(name) ? handles.get(name) : undefined;
    },
    enabled(): readonly Ability[] {
      return order.map((n) => handles.get(n)!);
    },
    stateOf(name: string): 'enabled' | 'disabled' {
      return current.has(name) ? 'enabled' : 'disabled';
    },
    *enable(factory: AbilityFactory): Operation<Ability> {
      // The content store the harness installed (the null store when none was):
      // an ability that reads documents resolves them through it.
      const attachments = yield* Attachments.expect();
      // Every service the harness bound, so `service(name)` answers inside the factory — and what the
      // manifest requires must be among them, or the factory does not run: the refusal names the block
      // whose presence would bind it, before an unset context can be the thing that reports it.
      const bound = yield* Services.get();
      if (factory.manifest) requireBound(bound, factory.manifest.name, factory.manifest.services);

      // The stored config is checked against the manifest BEFORE the factory
      // runs: a factory handed a malformed config must not be the thing that
      // reports it, and must not have run at all. A factory that declares no
      // manifest is checked after, against the manifest it returns.
      const declaredManifest = factory.manifest;
      if (declaredManifest?.configSchema) {
        const stored = yield* configStore.get(declaredManifest.name);
        if (stored !== undefined) validateConfigShape(declaredManifest.name, stored, declaredManifest.configSchema);
      }

      const [scope, destroy] = createScope();
      let added = false;
      return yield* scoped(function* () {
        // Factory threw, validation failed, or the caller was halted before
        // the ability entered the registry → tear down its detached scope
        // (best-effort; the original error wins). Registered with ensure(),
        // not a finally: cleanup that yields inside a finally takes a halted
        // frame out of unwind mode and the halt is lost (Effection's contract).
        yield* ensure(function* () {
          if (added) return;
          try {
            yield* call(() => destroy());
          } catch {
            /* teardown error on the failure path — original error wins */
          }
        });
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
                    if (bound !== undefined) yield* Services.set(bound);
                    yield* Attachments.set(attachments);
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

        // The requirement is the manifest the registry registers. The static check above refused before
        // construction where it could; a factory that carries no static manifest declares in the one it returns,
        // and that declaration is held to the same bag before anything is registered.
        requireBound(bound, ability.manifest.name, ability.manifest.services);

        const declared = ability.manifest.abilityProtocolVersion ?? '3.0';
        if (!SUPPORTED_ABILITY_PROTOCOL_VERSIONS.includes(declared)) {
          throw new Error(
            `Ability "${ability.manifest.name}" declares abilityProtocolVersion="${declared}", ` +
              `but the framework supports [${SUPPORTED_ABILITY_PROTOCOL_VERSIONS.map((v) => `"${v}"`).join(', ')}]. ` +
              `Upgrade the ability or use a framework version that supports this protocol.`,
          );
        }

        if (!declaredManifest?.configSchema) {
          const existingConfig = yield* configStore.get(ability.manifest.name);
          if (existingConfig !== undefined && ability.manifest.configSchema) {
            validateConfigShape(ability.manifest.name, existingConfig, ability.manifest.configSchema);
          }
        }

        // Namespace-collision guard. The catalog scopes abilities by handle
        // (`acme/web` vs `lloyal/web`), but the runtime/model surface is
        // UNSCOPED — `manifest.name` keys this registry, and `protocol.name` +
        // each tool name address the ability in the shared spine the model reads.
        // Two same-short-named abilities from different publishers therefore collide
        // here, on the model-facing faces (otherwise spine-render emits two CATALOG_ENTRY
        // blocks with the same protocol/tool names — silent routing ambiguity +
        // a collided BOUNDARY_MARKER). Fail loud, naming both abilities, so the
        // integrator knows it's a cross-publisher clash — not their bug. The name's
        // own current entry is not a clash: enabling it again SUPERSEDES it.
        const incomingProtocol = ability.manifest.protocol.name;
        const incomingTools = ability.manifest.protocol.tools;
        for (const [name, { ability: existing }] of current) {
          if (name === ability.manifest.name) continue;
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

        // Enable first, then the name resolves to it: a name already enabled is SUPERSEDED — its entry
        // leaves the roster and keeps serving whoever holds it until they release it. The handle is the same
        // object either way, so what a run captured now answers the new entry's tools.
        const name = ability.manifest.name;
        const prior = current.get(name);
        if (!prior) order.push(name);
        current.set(name, { name, ability, destroy, holders: new Set(holdsOn.get(name)), retired: false });
        let handle = handles.get(name);
        if (handle) handle.rebind(ability);
        else {
          handle = new Handle(name, ability);
          handles.set(name, handle);
        }
        added = true;
        if (prior) yield* retire(prior);
        return handle;
      });
    },
    *disable(name: string): Operation<void> {
      const entry = current.get(name);
      if (!entry) return;
      current.delete(name);
      const idx = order.indexOf(name);
      if (idx >= 0) order.splice(idx, 1);
      yield* retire(entry);
    },
  };

  internals.set(registry, {
    *hold(names) {
      const hold: Hold = {};
      for (const name of names) {
        const entry = current.get(name);
        if (!entry) continue;
        let holds = holdsOn.get(name);
        if (!holds) holdsOn.set(name, (holds = new Set()));
        holds.add(hold);
        entry.holders.add(hold);
      }
      yield* ensure(function* () {
        for (const name of names) holdsOn.get(name)?.delete(hold);
        // Every entry of the held names — the one serving and the ones that left the roster meanwhile.
        for (const entry of [...names.map((n) => current.get(n)), ...lingering]) {
          if (!entry || !entry.holders.delete(hold)) continue;
          if (entry.retired && entry.holders.size === 0) yield* end(entry, 'at its last holder\'s release');
        }
      });
    },
  });

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
      const entry = current.get(name);
      if (entry) yield* end(entry, 'at the registry\'s exit');
    }
    current.clear();
    order.length = 0;
    for (const entry of [...lingering]) yield* end(entry, 'at the registry\'s exit');
    handles.clear();
  });

  return registry;
}

/**
 * The registry accessor: the enabled ability named, or a refusal that names it.
 * What `(yield* AbilityRegistryCtx.expect()).byName(name)!` said with a bang.
 *
 * @category Rig
 */
export function* ability(name: string): Operation<Ability> {
  const registry = yield* AbilityRegistryCtx.expect();
  const found = registry.byName(name);
  if (!found) throw new Error(`ability "${name}" is not enabled`);
  return found;
}

/**
 * Whether an ability needs stored config to enable, read from its manifest's
 * `configSchema.required` — so a new ability is a list entry and nothing else.
 *
 * @category Rig
 */
export function abilityRequiresConfig(factory: AbilityFactory): boolean {
  const schema = factory.manifest?.configSchema as { required?: unknown } | undefined;
  return Array.isArray(schema?.required) && schema.required.length > 0;
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
