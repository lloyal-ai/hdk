/**
 * App protocol types — what a third-party app developer declares + what
 * the framework consumes when registering and rendering apps.
 *
 * Three groups of types live here:
 *
 * 1. **Declarative manifest** ({@link AppManifest}, {@link AppProtocol},
 *    {@link AppHints}). Authored in `app.json` and imported into the
 *    factory; describes what the app *is* without any runtime values.
 *
 * 2. **Runtime App object** ({@link App}, {@link SkillTemplateFn},
 *    {@link ExamplesTemplateFn}). Assembled by the {@link AppFactory} that
 *    `defineApp(manifest, setup)` returns, bundling the manifest with the
 *    setup's live `Source`, `Tool[]`, and template renderers.
 *
 * 3. **Per-spawn render context** ({@link AgentRenderCtx},
 *    {@link ExamplesRenderCtx}). Passed by the framework to template
 *    renderers when constructing a per-spawn preamble.
 *
 * Plus {@link AppFactory} (what the registry runs to construct an App)
 * and {@link ConfigFlow} for the optional credential handoff.
 *
 * @packageDocumentation
 * @category Protocol
 */

import type { Operation } from 'effection';
import type { Source } from './source';
import type { Tool } from './Tool';
import type { JsonSchema } from './types';

// ── Manifest (declarative — what app.json declares) ──────────────

/**
 * The model-facing identity of an app — three fields under
 * `manifest.protocol` in `app.json`. The framework renders these into
 * the boundary marker, the spine catalog entry,
 * and the auth-guard allowed-tools set.
 *
 * Constraints (enforced synchronously by `defineApp`):
 * - `name` matches `[a-z][a-z0-9_-]{1,63}`.
 * - `tools` is a non-empty array of tool-name strings, each matching the
 *   same regex as `name`. Must cover exactly the keys of the app's
 *   `tools` map supplied to `defineApp`.
 * - `useWhen` is a single sentence of printable characters, bounded in
 *   length, with no chat-role markers (`SYSTEM:`/`USER:`/etc.), no
 *   markdown code fences, and no newlines.
 */
export interface AppProtocol {
  /** Model-facing protocol identifier (e.g., `"web_research"`). */
  readonly name: string;
  /** Single-sentence routing hint rendered into the catalog `Use when:` line. */
  readonly useWhen: string;
  /** Tool names exposed by this protocol; must match the app's `tools` map keys. */
  readonly tools: readonly string[];
}

/**
 * Optional UX/marketplace metadata. Not part of the model-facing surface;
 * surfaced to harness UI, marketplace listings, and capability disclosure
 * at install time.
 */
export interface AppHints {
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
 * The auxiliary model roles an app can declare it needs, via
 * {@link AppManifest.requires}. A closed set — the disclosure sibling of
 * {@link AppHints.authKind} and the worker's `entitlements` taxonomy: the
 * harness provisions each required role and publishes the bound service on the
 * framework context the factory reads (`RerankerCtx`) *before* the factory
 * runs. `llm` is never listed — it is the harness's own trunk model, always
 * present; apps declare only the *auxiliary* roles they consume. `embedding`
 * is reserved (no consumer yet).
 */
export const APP_MODEL_ROLES = ['reranker', 'embedding'] as const;

/** One of the closed {@link APP_MODEL_ROLES}. */
export type AppModelRole = (typeof APP_MODEL_ROLES)[number];

/**
 * The declarative app manifest — content of `app.json` plus the
 * `appProtocolVersion` declaration. Imported into the app's factory
 * and passed to `defineApp(...)`.
 *
 * `manifest.name` is the **app identifier** used in code paths
 * (`SpawnSpec.assignedApp`, `registry.byName(...)`, the AppConfigStore
 * key, filesystem paths). The model never sees this — it only sees
 * `manifest.protocol.name`. One app, one protocol.
 */
export interface AppManifest {
  /** App identifier used for routing, config storage, and registry lookup. */
  readonly name: string;
  /**
   * Which codified App protocol version this app targets. The framework
   * refuses to register apps whose declared version is not in
   * `SUPPORTED_APP_PROTOCOL_VERSIONS` (currently `['3.0']`).
   */
  readonly appProtocolVersion?: string;
  /** The model-facing identity. */
  readonly protocol: AppProtocol;
  /**
   * The auxiliary model roles this app needs to function (e.g. `['reranker']`
   * when a tool scores content). The harness reads this *before* the factory
   * runs, provisions each role, and publishes the bound service on the
   * framework context the factory reads (`RerankerCtx`). Absent / empty means
   * the app needs only the trunk `llm`. A governed disclosure — projected into
   * the attention surface + signed into the catalog, like `entitlements`.
   */
  readonly requires?: readonly AppModelRole[];
  /** Optional UX/marketplace metadata. */
  readonly hints?: AppHints;
  /**
   * JSON Schema declaring what config the app needs. The framework
   * validates the app's stored config against it at enable time (when the
   * factory's constructed manifest is available). The `x-secret: true`
   * field annotation signals sensitive values (harness UX masks them, may
   * prefer secure storage backend).
   */
  readonly configSchema?: JsonSchema;
}

// ── Per-spawn render context ─────────────────────────────────────

/**
 * Variables the framework provides to `skill.eta` template renderers
 * at per-spawn render time. Apps reference these as `it.agentCount`,
 * `it.maxTurns`, etc. inside their Eta templates.
 *
 * App-specific additional variables (e.g., corpus apps' TOC) can be
 * supplied by extending the render context inside the App's factory —
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
 * fields of {@link AgentRenderCtx}. Apps can reference `it.name`
 * (protocol name) and `it.tools` (the protocol's tool-name list) when
 * authoring discipline content.
 */
export interface ExamplesRenderCtx extends AgentRenderCtx {
  /** The protocol's name (same as `app.manifest.protocol.name`). */
  readonly name: string;
  /** The protocol's tool-name list (same as `app.manifest.protocol.tools`). */
  readonly tools: readonly string[];
}

/**
 * Function alternative to a string `skill.eta` template — for apps whose
 * per-spawn prompt needs runtime parameterization beyond what Eta covers.
 *
 * The returned string is the per-spawn body; the framework prepends
 * `BOUNDARY_MARKER(protocol.name)` and (optionally) appends the rendered
 * `examples.eta`. The function MUST NOT return content containing the
 * literal `Apply the **` substring (the framework prepends it and
 * `defineApp` cannot statically validate function outputs — the first-render
 * check on canonical apps catches it).
 */
export type SkillTemplateFn = (params: AgentRenderCtx) => string;

/**
 * Function alternative to a string `examples.eta` template.
 *
 * Per-spawn only — examples are rendered into the
 * preamble of agents assigned to *this* app, never into the shared spine.
 */
export type ExamplesTemplateFn = (params: ExamplesRenderCtx) => string;

// ── Config flow ───────────────────────────────────────────────────

/**
 * Interactive config-acquisition flow for OAuth-like protocols the app
 * drives. This is credential **acquisition**, not lifecycle: it obtains
 * config (tokens) and the harness writes the result to `AppConfigStore`.
 * It is unrelated to enable/disable — the actual authentication happens
 * at the provider, not in the framework.
 *
 * Harness calls `initiate` → app returns a handoff URL + optional
 * callback param validator → harness opens the URL → user completes auth
 * → harness captures callback params → harness validates via
 * `callbackValidator` (if provided) → harness calls `complete` → app
 * returns the full config object → framework validates against
 * `manifest.configSchema` → harness writes the whole-replace config to
 * `AppConfigStore`.
 *
 * Both steps run inside the harness's Effection scope; if a flow needs
 * to read existing config it does `yield* AppConfigStoreCtx.expect()`
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

// ── Runtime App object ────────────────────────────────────────────

/**
 * The runtime artifact an app's {@link AppFactory} returns — assembled by
 * `defineApp` from the declarative {@link AppManifest} and the setup's live
 * `Source`, `Tool[]`, and prompt templates the framework needs at spawn time.
 *
 * The factory (from `defineApp(manifest, setup)`) is a zero-arg
 * `Operation<App>` whose `setup` reads config from `AppConfigStoreCtx` and the
 * shared reranker from `RerankerCtx`.
 * Both npm-distributed apps and signed-bundle apps use the identical
 * factory signature.
 */
export interface App {
  /** Same as `manifest.name` — routing key. */
  readonly name: string;
  /** The declarative manifest. */
  readonly manifest: AppManifest;
  /** The app's Source (provides per-domain chunking + tools). */
  readonly source: Source;
  /**
   * The tool instances exposed by this app. Their names must match
   * `manifest.protocol.tools` exactly. The framework concatenates all
   * registered apps' `tools` into the spine prefill (one shared decode
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
   * app. Not surfaced in the shared spine.
   */
  readonly examples?: string | ExamplesTemplateFn;
  /** Optional config schema (same as `manifest.configSchema`). */
  readonly configSchema?: JsonSchema;
  /** Optional UX hints (same as `manifest.hints`). */
  readonly hints?: AppHints;
  /** Optional interactive config flow. */
  readonly configFlow?: ConfigFlow;
}

/**
 * A zero-arg Operation that constructs an {@link App} — the value
 * `defineApp(manifest, setup)` returns. This — not a constructed `App` — is
 * what the registry consumes via `registry.enable(factory)` (the one enable
 * path, whether at boot or dynamically): the registry runs the factory inside a
 * per-app **detached** Effection scope that it seeds with `AppConfigStoreCtx` /
 * `AppRegistryCtx` / `RerankerCtx`, so the `setup` reads its config and
 * reranker, does any setup, and returns the runtime pieces `defineApp`
 * validates + assembles into the App.
 *
 * **Setup and teardown are structured, not hooks.** The `setup` you pass to
 * `defineApp` *is* the setup. For resources that need teardown (a connection, a
 * watcher), `setup` is a `resource()` that allocates, registers cleanup with
 * `ensure(...)`, and `provide(...)`s the runtime pieces — the cleanup fires when
 * the app's detached scope is torn down (`registry.disable(name)`, or registry
 * scope exit). Apps with no external resources are a plain
 * `defineApp(manifest, function* () { return { source, tools, skill }; })`.
 * There are no `install`/`uninstall`/`enable`/`disable` hooks.
 *
 * Apps installed via `harness.dev install` (signed npm tarballs from the
 * canonical channel) export a factory made this way from their package entry
 * point — the harness imports it with a plain
 * `import { createXxxApp } from '@lloyal-labs/<name>-app'` and enables it with
 * `registry.enable(createXxxApp)`.
 *
 * The factory also carries its {@link AppManifest} statically as
 * {@link AppFactory.manifest}, so the harness boot can read what the app needs
 * (e.g. `manifest.requires`) *without* running the factory — provisioning must
 * happen before construction. Apps set it from their `app.json` (the scaffold
 * does this).
 */
export interface AppFactory {
  (): Operation<App>;
  /**
   * The app's declarative {@link AppManifest}, advertised statically so the
   * harness boot can read what the app needs (e.g. `manifest.requires`) BEFORE
   * running the factory. Apps set it from their `app.json`; a factory that
   * doesn't advertise one is still valid — the boot just can't pre-provision
   * for it (it falls back to the factory's own construction-time reads).
   */
  readonly manifest?: AppManifest;
}

/**
 * The framework-tracked runtime state of an app: `'enabled'` once its
 * factory has run and it sits in the registry, `'disabled'` otherwise.
 * Binary by design — richer states (configured, authenticated, ready) are
 * harness UX rollups or app-internal runtime concerns, not framework
 * state.
 */
export type AppState = 'enabled' | 'disabled';

// ── App registry ─────────────────────────────────────────────────

/**
 * The harness-owned registry of enabled apps. Lives behind
 * `AppRegistryCtx`; the auth-guard consults it at
 * tool-dispatch time to resolve the allowed-tools set for an
 * App-assigned spawn (`SpawnSpec.assignedApp`). The concrete factory
 * `createAppRegistry(...)` lives in `@lloyal-labs/rig`; dynamic
 * enable/disable are methods on this interface.
 *
 * Registry state is the single source of truth for which apps are
 * enabled within a harness scope. `createAppRegistry({ configStore })`
 * returns an empty registry; the harness enables its boot set with a
 * `registry.enable(factory)` call per app, each running in its own
 * detached Effection scope. `disable` (or registry scope-exit) tears that
 * scope down, firing the app factory's `ensure(...)` teardown. There are
 * no install/uninstall hooks.
 */
export interface AppRegistry {
  /**
   * Look up an enabled app by `manifest.name` (the routing key —
   * **not** `manifest.protocol.name`). Returns `undefined` if no app
   * with that name is enabled.
   */
  byName(name: string): App | undefined;
  /**
   * Snapshot of currently-enabled apps in registration order. The
   * spine renderer walks this list to compose the catalog;
   * order is observable to the model.
   */
  enabled(): readonly App[];
  /**
   * Binary state of an app: `'enabled'` if it's in the registry,
   * `'disabled'` otherwise. Convenience over `byName(name) !==
   * undefined` for harness UX.
   */
  stateOf(name: string): AppState;
  /**
   * Enable an app dynamically (the mid-session enable path). Runs
   * the factory in a fresh per-app detached scope (seeded with `App*Ctx`),
   * validates the manifest, and adds it. Returns the constructed App.
   * Throws — and tears down the partial scope — if the factory
   * throws, validation fails, or the name is already enabled. The boot
   * set is enabled the same way — a `registry.enable(factory)` call per app.
   */
  enable(factory: AppFactory): Operation<App>;
  /**
   * Disable an app dynamically: remove it and tear down its detached
   * scope, firing the factory's `ensure(...)` teardown. A throwing
   * teardown is logged but the app is removed regardless. No-op for an
   * unknown name.
   */
  disable(name: string): Operation<void>;
}
