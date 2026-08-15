/**
 * Ability protocol types — what a third-party ability developer declares + what
 * the framework consumes when registering and rendering abilities.
 *
 * Three groups of types live here:
 *
 * 1. **Declarative manifest** ({@link AbilityManifest}, {@link AbilityProtocol},
 *    {@link AbilityHints}). Authored in `ability.json` and imported into the
 *    factory; describes what the ability *is* without any runtime values.
 *
 * 2. **Runtime Ability object** ({@link Ability}, {@link SkillTemplateFn},
 *    {@link ExamplesTemplateFn}). Assembled by the {@link AbilityFactory} that
 *    `defineAbility(manifest, setup)` returns, bundling the manifest with the
 *    setup's live `Source`, `Tool[]`, and template renderers.
 *
 * 3. **Per-spawn render context** ({@link AgentRenderCtx},
 *    {@link ExamplesRenderCtx}). Passed by the framework to template
 *    renderers when constructing a per-spawn preamble.
 *
 * Plus {@link AbilityFactory} (what the registry runs to construct an Ability)
 * and {@link ConfigFlow} for the optional credential handoff.
 *
 * @packageDocumentation
 * @category Protocol
 */

import type { Operation } from 'effection';
import type { Source } from './source';
import type { Tool } from './Tool';
import type { JsonSchema } from './types';

// ── Manifest (declarative — what ability.json declares) ──────────────

/**
 * The model-facing identity of an ability — three fields under
 * `manifest.protocol` in `ability.json`. The framework renders these into
 * the boundary marker, the spine catalog entry,
 * and the auth-guard allowed-tools set.
 *
 * Constraints (enforced synchronously by `defineAbility`):
 * - `name` matches `[a-z][a-z0-9_-]{1,63}`.
 * - `tools` is a non-empty array of tool-name strings, each matching the
 *   same regex as `name`. Must cover exactly the keys of the ability's
 *   `tools` map supplied to `defineAbility`.
 * - `useWhen` is a single sentence of printable characters, bounded in
 *   length, with no chat-role markers (`SYSTEM:`/`USER:`/etc.), no
 *   markdown code fences, and no newlines.
 */
export interface AbilityProtocol {
  /** Model-facing protocol identifier (e.g., `"web_research"`). */
  readonly name: string;
  /** Single-sentence routing hint rendered into the catalog `Use when:` line. */
  readonly useWhen: string;
  /** Tool names exposed by this protocol; must match the ability's `tools` map keys. */
  readonly tools: readonly string[];
}

/**
 * Optional UX/marketplace metadata. Not part of the model-facing surface;
 * surfaced to harness UI, marketplace listings, and capability disclosure
 * at install time.
 */
export interface AbilityHints {
  /** Short display name for chips/tabs (e.g., `"web"`, `"jira"`). */
  readonly shortName?: string;
  /** Long-form description for marketplace listings. */
  readonly description?: string;
  /** URL to an icon (svg/png) the harness may display. */
  readonly iconUrl?: string;
  /** Coarse capability disclosure for install-time review. */
  readonly authKind?: 'oauth' | 'apikey' | 'path' | 'token' | 'none';
}

/**
 * The HDK **Services** an ability can declare it needs, via {@link AbilityManifest.services}.
 * A Service is an auxiliary platform capability the harness provides as a shared,
 * injected instance: the ability declares the *service* (not a model), and the platform
 * binds the implementation (which model backs it) one layer down at the
 * harness/deploy level. A closed set today (`reranker`, `embedding`); extensible as
 * the platform adds services. A disclosure sibling of {@link AbilityHints.authKind} and
 * the worker's `entitlements` taxonomy: the harness provisions each required service
 * and publishes the bound instance on the framework context the factory reads
 * (`RerankerCtx`) *before* the factory runs. The trunk `llm` is never listed — it is
 * the harness's own model, always present; abilities declare only the *auxiliary* services
 * they consume. `embedding` is reserved (no consumer yet).
 */
export const SERVICES = ['reranker', 'embedding'] as const;

/** One of the closed {@link SERVICES} — an HDK service an ability can require. */
export type Service = (typeof SERVICES)[number];

/**
 * The declarative ability manifest — content of `ability.json` plus the
 * `appProtocolVersion` declaration. Imported into the ability's factory
 * and passed to `defineAbility(...)`.
 *
 * `manifest.name` is the **ability identifier** used in code paths
 * (`SpawnSpec.assignedAbility`, `registry.byName(...)`, the AbilityConfigStore
 * key, filesystem paths). The model never sees this — it only sees
 * `manifest.protocol.name`. One ability, one protocol.
 */
export interface AbilityManifest {
  /** Ability identifier used for routing, config storage, and registry lookup. */
  readonly name: string;
  /**
   * Which codified Ability protocol version this ability targets. The framework
   * refuses to register abilities whose declared version is not in
   * `SUPPORTED_ABILITY_PROTOCOL_VERSIONS` (currently `['3.0']`).
   */
  readonly appProtocolVersion?: string;
  /** The model-facing identity. */
  readonly protocol: AbilityProtocol;
  /**
   * The HDK {@link Service}s this ability needs to function (e.g. `['reranker']` when
   * a tool scores content). The harness reads this *before* the factory runs,
   * provisions each service, and publishes the bound instance on the framework
   * context the factory reads (`RerankerCtx`). Absent / empty means the ability needs
   * only the trunk `llm`. A governed disclosure — a peer to `entitlements` (NOT the
   * attention surface): signed into the catalog + shown to the reviewer.
   */
  readonly services?: readonly Service[];
  /** Optional UX/marketplace metadata. */
  readonly hints?: AbilityHints;
  /**
   * JSON Schema declaring what config the ability needs. The framework
   * validates the ability's stored config against it at enable time (when the
   * factory's constructed manifest is available). The `x-secret: true`
   * field annotation signals sensitive values (harness UX masks them, may
   * prefer secure storage backend).
   */
  readonly configSchema?: JsonSchema;
}

// ── Per-spawn render context ─────────────────────────────────────

/**
 * Variables the framework provides to `skill.eta` template renderers
 * at per-spawn render time. Abilities reference these as `it.agentCount`,
 * `it.maxTurns`, etc. inside their Eta templates.
 *
 * Ability-specific additional variables (e.g., corpus abilities' TOC) can be
 * supplied by extending the render context inside the Ability's factory —
 * the framework spreads `params` into the Eta template's render data.
 */
export interface AgentRenderCtx {
  /** Total number of agents spawned in the current fan-out. */
  readonly agentCount: number;
  /** Task descriptions of the *other* agents in this fan-out. */
  readonly siblingTasks: readonly string[];
  /** Tool-call budget for this spawn. */
  readonly maxTurns: number;
  /** Today's date in ISO format. */
  readonly date: string;
  /** Position in a chain orchestrator (0-indexed); 0 for parallel fan-outs. */
  readonly taskIndex: number;
}

/**
 * Variables provided to `examples.eta` renderers in addition to all
 * fields of {@link AgentRenderCtx}. Abilities can reference `it.name`
 * (protocol name) and `it.tools` (the protocol's tool-name list) when
 * authoring discipline content.
 */
export interface ExamplesRenderCtx extends AgentRenderCtx {
  /** The protocol's name (same as `ability.manifest.protocol.name`). */
  readonly name: string;
  /** The protocol's tool-name list (same as `ability.manifest.protocol.tools`). */
  readonly tools: readonly string[];
}

/**
 * Function alternative to a string `skill.eta` template — for abilities whose
 * per-spawn prompt needs runtime parameterization beyond what Eta covers.
 *
 * The returned string is the per-spawn body; the framework prepends
 * `BOUNDARY_MARKER(protocol.name)` and (optionally) appends the rendered
 * `examples.eta`. The function MUST NOT return content containing the
 * literal `Apply the **` substring (the framework prepends it and
 * `defineAbility` cannot statically validate function outputs — the first-render
 * check on canonical abilities catches it).
 */
export type SkillTemplateFn = (params: AgentRenderCtx) => string;

/**
 * Function alternative to a string `examples.eta` template.
 *
 * Per-spawn only — examples are rendered into the
 * preamble of agents assigned to *this* ability, never into the shared spine.
 */
export type ExamplesTemplateFn = (params: ExamplesRenderCtx) => string;

// ── Config flow ───────────────────────────────────────────────────

/**
 * Interactive config-acquisition flow for OAuth-like protocols the ability
 * drives. This is credential **acquisition**, not lifecycle: it obtains
 * config (tokens) and the harness writes the result to `AbilityConfigStore`.
 * It is unrelated to enable/disable — the actual authentication happens
 * at the provider, not in the framework.
 *
 * Harness calls `initiate` → ability returns a handoff URL + optional
 * callback param validator → harness opens the URL → user completes auth
 * → harness captures callback params → harness validates via
 * `callbackValidator` (if provided) → harness calls `complete` → ability
 * returns the full config object → framework validates against
 * `manifest.configSchema` → harness writes the whole-replace config to
 * `AbilityConfigStore`.
 *
 * Both steps run inside the harness's Effection scope; if a flow needs
 * to read existing config it does `yield* AbilityConfigStoreCtx.expect()`
 * directly — there is no separate context parameter.
 */
export interface ConfigFlow {
  /** Initiates the auth flow; returns a handoff URL the harness opens. */
  initiate(): Operation<{
    handoffUrl?: string;
    callbackValidator?: (params: unknown) => boolean;
  }>;
  /** Receives callback params from the harness; returns the full config. */
  complete(callbackParams: unknown): Operation<Record<string, unknown>>;
}

// ── Runtime Ability object ────────────────────────────────────────────

/**
 * The runtime artifact an ability's {@link AbilityFactory} returns — assembled by
 * `defineAbility` from the declarative {@link AbilityManifest} and the setup's live
 * `Source`, `Tool[]`, and prompt templates the framework needs at spawn time.
 *
 * The factory (from `defineAbility(manifest, setup)`) is a zero-arg
 * `Operation<Ability>` whose `setup` reads config from `AbilityConfigStoreCtx` and the
 * shared reranker from `RerankerCtx`.
 * Both npm-distributed abilities and signed-bundle abilities use the identical
 * factory signature.
 */
export interface Ability {
  /** Same as `manifest.name` — routing key. */
  readonly name: string;
  /** The declarative manifest. */
  readonly manifest: AbilityManifest;
  /** The ability's Source (provides per-domain chunking + tools). */
  readonly source: Source;
  /**
   * The tool instances exposed by this ability. Their names must match
   * `manifest.protocol.tools` exactly. The framework concatenates all
   * registered abilities' `tools` into the spine prefill (one shared decode
   * of all schemas, amortized across every spawn in the pool).
   */
  readonly tools: readonly Tool[];
  /**
   * The per-spawn `skill.eta` template (string) or function. The
   * framework prepends the boundary marker; `skill.eta` MUST NOT
   * contain the literal `Apply the **` substring.
   */
  readonly skill: string | SkillTemplateFn;
  /**
   * Optional discipline content (GOOD/BAD examples, anti-patterns)
   * rendered into the per-spawn preamble of agents assigned to this
   * ability. Not surfaced in the shared spine.
   */
  readonly examples?: string | ExamplesTemplateFn;
  /** Optional config schema (same as `manifest.configSchema`). */
  readonly configSchema?: JsonSchema;
  /** Optional UX hints (same as `manifest.hints`). */
  readonly hints?: AbilityHints;
  /** Optional interactive config flow. */
  readonly configFlow?: ConfigFlow;
}

/**
 * A zero-arg Operation that constructs an {@link Ability} — the value
 * `defineAbility(manifest, setup)` returns. This — not a constructed `Ability` — is
 * what the registry consumes via `registry.enable(factory)` (the one enable
 * path, whether at boot or dynamically): the registry runs the factory inside a
 * per-ability **detached** Effection scope that it seeds with `AbilityConfigStoreCtx` /
 * `AbilityRegistryCtx` / `RerankerCtx`, so the `setup` reads its config and
 * reranker, does any setup, and returns the runtime pieces `defineAbility`
 * validates + assembles into the Ability.
 *
 * **Setup and teardown are structured, not hooks.** The `setup` you pass to
 * `defineAbility` *is* the setup. For resources that need teardown (a connection, a
 * watcher), `setup` is a `resource()` that allocates, registers cleanup with
 * `ensure(...)`, and `provide(...)`s the runtime pieces — the cleanup fires when
 * the ability's detached scope is torn down (`registry.disable(name)`, or registry
 * scope exit). Abilities with no external resources are a plain
 * `defineAbility(manifest, function* () { return { source, tools, skill }; })`.
 * There are no `install`/`uninstall`/`enable`/`disable` hooks.
 *
 * Abilities installed via `lloyal install` (signed npm tarballs from the
 * canonical channel) export a factory made this way from their package entry
 * point — the harness imports it with a plain
 * `import { createXxxAbility } from '@lloyal-labs/<name>-ability'` and enables it with
 * `registry.enable(createXxxAbility)`.
 *
 * The factory also carries its {@link AbilityManifest} statically as
 * {@link AbilityFactory.manifest}, so the harness boot can read what the ability needs
 * (e.g. `manifest.services`) *without* running the factory — provisioning must
 * happen before construction. Abilities set it from their `ability.json` (the scaffold
 * does this).
 */
export interface AbilityFactory {
  (): Operation<Ability>;
  /**
   * The ability's declarative {@link AbilityManifest}, advertised statically so the
   * harness boot can read what the ability needs (e.g. `manifest.services`) BEFORE
   * running the factory. Abilities set it from their `ability.json`; a factory that
   * doesn't advertise one is still valid — the boot just can't pre-provision
   * for it (it falls back to the factory's own construction-time reads).
   */
  readonly manifest?: AbilityManifest;
}

/**
 * The framework-tracked runtime state of an ability: `'enabled'` once its
 * factory has run and it sits in the registry, `'disabled'` otherwise.
 * Binary by design — richer states (configured, authenticated, ready) are
 * harness UX rollups or ability-internal runtime concerns, not framework
 * state.
 */
export type AbilityState = 'enabled' | 'disabled';

// ── Ability registry ─────────────────────────────────────────────────

/**
 * The harness-owned registry of enabled abilities. Lives behind
 * `AbilityRegistryCtx`; the auth-guard consults it at
 * tool-dispatch time to resolve the allowed-tools set for an
 * Ability-assigned spawn (`SpawnSpec.assignedAbility`). The concrete factory
 * `createAbilityRegistry(...)` lives in `@lloyal-labs/rig`; dynamic
 * enable/disable are methods on this interface.
 *
 * Registry state is the single source of truth for which abilities are
 * enabled within a harness scope. `createAbilityRegistry({ configStore })`
 * returns an empty registry; the harness enables its boot set with a
 * `registry.enable(factory)` call per ability, each running in its own
 * detached Effection scope. `disable` (or registry scope-exit) tears that
 * scope down, firing the ability factory's `ensure(...)` teardown. There are
 * no install/uninstall hooks.
 */
export interface AbilityRegistry {
  /**
   * Look up an enabled ability by `manifest.name` (the routing key —
   * **not** `manifest.protocol.name`). Returns `undefined` if no ability
   * with that name is enabled.
   */
  byName(name: string): Ability | undefined;
  /**
   * Snapshot of currently-enabled abilities in registration order. The
   * spine renderer walks this list to compose the catalog;
   * order is observable to the model.
   */
  enabled(): readonly Ability[];
  /**
   * Binary state of an ability: `'enabled'` if it's in the registry,
   * `'disabled'` otherwise. Convenience over `byName(name) !==
   * undefined` for harness UX.
   */
  stateOf(name: string): AbilityState;
  /**
   * Enable an ability dynamically (the mid-session enable path). Runs
   * the factory in a fresh per-ability detached scope (seeded with `Ability*Ctx`),
   * validates the manifest, and adds it. Returns the constructed Ability.
   * Throws — and tears down the partial scope — if the factory
   * throws, validation fails, or the name is already enabled. The boot
   * set is enabled the same way — a `registry.enable(factory)` call per ability.
   */
  enable(factory: AbilityFactory): Operation<Ability>;
  /**
   * Disable an ability dynamically: remove it and tear down its detached
   * scope, firing the factory's `ensure(...)` teardown. A throwing
   * teardown is logged but the ability is removed regardless. No-op for an
   * unknown name.
   */
  disable(name: string): Operation<void>;
}
