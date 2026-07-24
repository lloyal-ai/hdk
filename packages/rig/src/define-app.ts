/**
 * `defineApp(manifest, setup): AppFactory` — the one affordance an app author
 * calls. It pairs the declarative {@link AppManifest} (from `app.json`) with an
 * effectful `setup` that constructs the runtime pieces (`source`, `tools`,
 * `skill`, ...), and returns the {@link AppFactory} the harness enables.
 *
 * The returned factory also carries its `manifest` statically, so the harness
 * boot can read what the app needs (e.g. `manifest.requires`) BEFORE running
 * the factory — provisioning happens before construction.
 *
 * Validation is split by what's knowable when:
 *
 * - **Eager (at `defineApp` call = import time):** the manifest shape.
 *   `name` and `protocol.name` match `[a-z][a-z0-9_-]{1,63}`; `protocol.tools`
 *   is a non-empty unique array of names matching the same regex;
 *   `protocol.useWhen` is a single bounded sentence with no chat-role markers,
 *   code fences, or newlines (metadata sanitization); `appProtocolVersion` (if
 *   declared) is in `SUPPORTED_APP_PROTOCOL_VERSIONS`; `requires` (if present)
 *   is an array of the closed model-role set. A malformed manifest fails the
 *   moment the app module is imported.
 * - **At factory run (enable time):** the setup output. The `tools` map keys
 *   equal `manifest.protocol.tools[]` as a set (every declared tool has an
 *   implementation, no extras, each `.name` matches its key); and `skill`
 *   (string form) does not contain the literal `Apply the **` substring — the
 *   framework prepends the boundary marker, so an `skill.eta` with the line
 *   would emit it twice.
 *
 * Validation errors throw with a clear message naming the failing field and
 * the violated rule.
 *
 * @packageDocumentation
 * @category Protocol
 */

import type { Operation } from 'effection';
import type {
  Tool,
  Source,
  App,
  AppFactory,
  AppManifest,
  SkillTemplateFn,
  ExamplesTemplateFn,
  ConfigFlow,
  AppHints,
} from '@lloyal-labs/lloyal-agents';
import { APP_MODEL_ROLES } from '@lloyal-labs/lloyal-agents';
import { SUPPORTED_APP_PROTOCOL_VERSIONS } from './protocol';

/**
 * What an app's `setup` returns — the runtime pieces `defineApp` assembles into
 * the {@link App}, alongside the declarative manifest. The `manifest` is NOT
 * here: it is the first argument to {@link defineApp} (declared once, up front).
 */
export interface AppSetup {
  /** The app's Source. */
  source: Source;
  /**
   * Map of tool-name → Tool instance. Keys MUST equal
   * `manifest.protocol.tools[]` as a set (exact membership match — no
   * missing tools, no extras). Each value's `.name` property must match
   * its key (otherwise the catalog's `Tools:` line and the agent's
   * dispatched tool call would disagree).
   */
  tools: Readonly<Record<string, Tool>>;
  /**
   * The per-spawn template body. String → rendered via Eta with the
   * `AgentRenderCtx` fields available as `it.*`. Function → invoked
   * directly with the render context.
   *
   * MUST NOT contain the literal `Apply the **` substring when given as
   * a string — the framework prepends the boundary marker.
   */
  skill: string | SkillTemplateFn;
  /**
   * Optional discipline content rendered into the per-spawn preamble of
   * agents assigned to this app. Never enters the shared spine.
   */
  examples?: string | ExamplesTemplateFn;
  /** Optional UX/marketplace hints (overrides `manifest.hints` if both present). */
  hints?: AppHints;
  /** Optional interactive config flow. */
  configFlow?: ConfigFlow;
}

// ── Validation regexes / constants ───────────────────────────────

/**
 * Identifier shape for app names and protocol names. Lowercase ASCII
 * start, lowercase alphanumeric / underscore / hyphen rest, length 2-64.
 * This grammar is the M3 sanitization on shared-spine metadata — it
 * ensures app-supplied strings can't break the markdown bold in the
 * boundary marker (no `*`) and can't inject newlines, code fences, or
 * chat-role markers.
 */
const ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;

/**
 * Maximum length of `protocol.useWhen`. Bounded so the rendered catalog
 * stays compact and to limit the residual semantic-injection surface
 * available within the grammar's allowed character set.
 */
const USE_WHEN_MAX_LEN = 280;

/**
 * Patterns forbidden anywhere in `protocol.useWhen` — chat-role markers
 * (would confuse the model into treating the catalog text as a fake
 * conversation) and markdown code fences (would let an attacker break
 * out of the catalog block into structured content).
 */
const USE_WHEN_FORBIDDEN: readonly RegExp[] = [
  /\bSYSTEM:/i,
  /\bUSER:/i,
  /\bASSISTANT\s+calls?:/i,
  /\bASSISTANT:/i,
  /```/,
  /\r/,
  /\n/,
];

/** Substring whose presence in `skill` (string form) would cause double-emission. */
const BOUNDARY_MARKER_PREFIX = 'Apply the **';

// ── Validation helpers ───────────────────────────────────────────

function assertIdentifier(value: string, field: string): void {
  if (typeof value !== 'string') {
    throw new Error(`defineApp: ${field} must be a string, got ${typeof value}`);
  }
  if (!ID_RE.test(value)) {
    throw new Error(
      `defineApp: ${field} ${JSON.stringify(value)} does not match the required ` +
        `identifier grammar ${ID_RE.toString()} (lowercase alphanumeric + _-, length 2-64). ` +
        `This is an App protocol metadata invariant — names appear in the boundary ` +
        `marker and shared spine catalog where injection-prone characters must be excluded.`,
    );
  }
}

function assertUseWhen(value: string): void {
  if (typeof value !== 'string') {
    throw new Error(`defineApp: manifest.protocol.useWhen must be a string, got ${typeof value}`);
  }
  if (value.length === 0 || value.length > USE_WHEN_MAX_LEN) {
    throw new Error(
      `defineApp: manifest.protocol.useWhen length ${value.length} out of bounds ` +
        `[1, ${USE_WHEN_MAX_LEN}]. Keep it to a single short sentence.`,
    );
  }
  for (const pattern of USE_WHEN_FORBIDDEN) {
    if (pattern.test(value)) {
      throw new Error(
        `defineApp: manifest.protocol.useWhen contains forbidden pattern ${pattern.toString()}. ` +
          `useWhen renders into the shared spine catalog; chat-role markers, code fences, and ` +
          `line breaks are excluded to prevent injection at the catalog-text layer.`,
      );
    }
  }
}

function assertProtocolTools(tools: readonly string[]): void {
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error(
      `defineApp: manifest.protocol.tools must be a non-empty array of tool-name strings`,
    );
  }
  const seen = new Set<string>();
  for (const name of tools) {
    assertIdentifier(name, `manifest.protocol.tools[*] (${JSON.stringify(name)})`);
    if (seen.has(name)) {
      throw new Error(`defineApp: manifest.protocol.tools contains duplicate ${JSON.stringify(name)}`);
    }
    seen.add(name);
  }
}

function assertRequires(requires: unknown): void {
  // `requires` comes from `app.json` (parsed as untrusted JSON), so validate it
  // like the rest of the manifest: absent is fine; otherwise it must be an array
  // of the closed {@link APP_MODEL_ROLES} set. A malformed value would silently
  // break pre-provisioning (the boot reads `manifest.requires` before enable).
  if (requires === undefined) return;
  if (!Array.isArray(requires)) {
    throw new Error(
      `defineApp: manifest.requires must be an array of model roles, got ${typeof requires}`,
    );
  }
  for (const role of requires) {
    if (typeof role !== 'string' || !(APP_MODEL_ROLES as readonly string[]).includes(role)) {
      throw new Error(
        `defineApp: manifest.requires contains unknown role ${JSON.stringify(role)}; ` +
          `supported roles are ${JSON.stringify(APP_MODEL_ROLES)}.`,
      );
    }
  }
}

function assertAppProtocolVersion(version: string | undefined): void {
  // Undefined is permitted — apps that don't declare a version are
  // assumed to target the framework's default ("3.0"). The registry
  // (enable-time) may tighten this if needed.
  if (version === undefined) return;
  if (!SUPPORTED_APP_PROTOCOL_VERSIONS.includes(version)) {
    throw new Error(
      `defineApp: manifest.appProtocolVersion ${JSON.stringify(version)} is not in the ` +
        `supported set ${JSON.stringify(SUPPORTED_APP_PROTOCOL_VERSIONS)}. ` +
        `This build of @lloyal-labs/rig only validates apps targeting one of those versions.`,
    );
  }
}

function assertToolMapCoverage(
  protocolTools: readonly string[],
  toolsMap: Readonly<Record<string, Tool>>,
): void {
  const declared = new Set(protocolTools);
  const provided = new Set(Object.keys(toolsMap));

  // Missing — tools declared in the protocol but not supplied as instances.
  const missing: string[] = [];
  for (const name of declared) {
    if (!provided.has(name)) missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(
      `defineApp: tools map is missing implementations for protocol.tools: ` +
        `${JSON.stringify(missing)}. Every declared tool must have a corresponding ` +
        `entry in the \`tools\` map returned by setup.`,
    );
  }

  // Extras — tools supplied as instances but not declared in the protocol.
  const extras: string[] = [];
  for (const name of provided) {
    if (!declared.has(name)) extras.push(name);
  }
  if (extras.length > 0) {
    throw new Error(
      `defineApp: tools map contains entries not declared in manifest.protocol.tools: ` +
        `${JSON.stringify(extras)}. Add them to protocol.tools or remove from the tools map ` +
        `— the catalog Tools: line is rendered from protocol.tools and the auth-guard's ` +
        `allowed-tools set is derived from the same array, so extras would never be callable.`,
    );
  }

  // Name agreement — each Tool instance's .name must match its key.
  for (const [key, tool] of Object.entries(toolsMap)) {
    if (tool.name !== key) {
      throw new Error(
        `defineApp: tools[${JSON.stringify(key)}].name = ${JSON.stringify(tool.name)} ` +
          `does not match its map key. The map key is what the framework dispatches against; ` +
          `the Tool's name is what the model sees in the schema. They must agree.`,
      );
    }
  }
}

function assertSkillTemplate(skill: string | SkillTemplateFn): void {
  if (typeof skill === 'function') {
    // Function-typed templates can't be statically validated here. The
    // framework's first-render check catches double-emission
    // at the first preamble render, not at defineApp time.
    return;
  }
  if (typeof skill !== 'string') {
    throw new Error(`defineApp: setup.skill must be a string or SkillTemplateFn, got ${typeof skill}`);
  }
  if (skill.includes(BOUNDARY_MARKER_PREFIX)) {
    throw new Error(
      `defineApp: skill template contains the literal ${JSON.stringify(BOUNDARY_MARKER_PREFIX)} substring. ` +
        `The framework prepends \`Apply the **<name>** protocol.\\n\\n\` via BOUNDARY_MARKER at ` +
        `render time; including it in the template would emit it twice. Strip the ` +
        `\`Apply the **...** protocol.\` line (and its trailing blank line) from skill.eta.`,
    );
  }
}

// ── defineApp ─────────────────────────────────────────────────────

/**
 * Define an app from its declarative `manifest` and an effectful `setup`, and
 * return the {@link AppFactory} the registry enables.
 *
 * The manifest is validated **eagerly** (at this call — import time), so a
 * malformed manifest fails fast. `setup` runs when the factory is enabled; its
 * returned `tools`/`skill` are validated then, and the {@link App} is assembled
 * (tools ordered to match `protocol.tools`). The returned factory carries
 * `manifest` statically for pre-enable provisioning.
 *
 * @example
 * ```ts
 * import manifest from '../app.json';
 *
 * export const createJiraApp = defineApp(manifest, function* () {
 *   const cfg = yield* AppConfigStoreCtx.expect();
 *   const conf = yield* cfg.get('jira');
 *   if (!conf) throw new Error('jira app requires config');
 *   const source = new JiraSource(conf);
 *   return {
 *     source,
 *     tools: { jira_search: source.searchTool, jira_read: source.readTool },
 *     skill,
 *   };
 * });
 * ```
 */
export function defineApp(
  manifest: AppManifest,
  setup: () => Operation<AppSetup>,
): AppFactory {
  // Eager manifest validation — a malformed manifest fails at import, before
  // the app is ever enabled. (Tool-map + skill checks need the setup output, so
  // they run when the factory runs — the same enable-time point as before.)
  assertIdentifier(manifest.name, 'manifest.name');
  assertAppProtocolVersion(manifest.appProtocolVersion);
  assertIdentifier(manifest.protocol.name, 'manifest.protocol.name');
  assertUseWhen(manifest.protocol.useWhen);
  assertProtocolTools(manifest.protocol.tools);
  assertRequires(manifest.requires);

  const factory = function* (): Operation<App> {
    const parts = yield* setup();

    assertToolMapCoverage(manifest.protocol.tools, parts.tools);
    assertSkillTemplate(parts.skill);

    // Preserve `protocol.tools` insertion order in the runtime tools array
    // — that's the order the catalog renders and the order the spine
    // prefill receives schemas in. The framework relies on stable ordering
    // for the §10.1 snapshot gate.
    const tools = manifest.protocol.tools.map((name) => parts.tools[name]);

    return {
      name: manifest.name,
      manifest,
      source: parts.source,
      tools,
      skill: parts.skill,
      examples: parts.examples,
      configSchema: manifest.configSchema,
      hints: parts.hints ?? manifest.hints,
      configFlow: parts.configFlow,
    };
  };

  // Advertise the manifest statically so the harness boot can read it (e.g.
  // `requires`) before running the factory.
  return Object.assign(factory, { manifest });
}
