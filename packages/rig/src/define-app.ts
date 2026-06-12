/**
 * `defineApp(spec): App` — sync wiring helper called inside every app's
 * factory after constructing its `Source` and `Tool[]` instances.
 *
 * Performs all framework-side validations of the app's declared shape
 * before the App enters the registry:
 *
 * - **Manifest schema.** `name` and `protocol.name` match
 *   `[a-z][a-z0-9_-]{1,63}`; `protocol.tools` is a non-empty unique array
 *   of names matching the same regex; `protocol.useWhen` is a single
 *   bounded sentence with no chat-role markers, code fences, or newlines
 *   (metadata sanitization).
 * - **App protocol version.** `manifest.appProtocolVersion` is in
 *   `SUPPORTED_APP_PROTOCOL_VERSIONS`. Absence is permitted
 *   (treated as `"3.0"`).
 * - **Tool map coverage.** The keys of the supplied `tools` object equal
 *   `manifest.protocol.tools[]` as a set — every declared tool has an
 *   implementation, no extras.
 * - **Boundary-marker double-emission.** `skill` (when string-typed) MUST
 *   NOT contain the literal `Apply the **` substring — the framework
 *   prepends the marker via `BOUNDARY_MARKER`, so an `skill.eta` that
 *   includes the line would emit it twice.
 *
 * Validation errors throw synchronously with a clear message naming the
 * failing field and the violated rule. App factories should call
 * `defineApp` last (after `yield*`ing tool factories) so a malformed
 * manifest fails at construction time, not later at registration.
 *
 * @packageDocumentation
 * @category Protocol
 */

import type { Operation } from 'effection';
import type {
  Tool,
  Source,
  App,
  AppManifest,
  SkillTemplateFn,
  ExamplesTemplateFn,
  ConfigFlow,
  AppHints,
} from '@lloyal-labs/lloyal-agents';
import { SUPPORTED_APP_PROTOCOL_VERSIONS } from './protocol';

/**
 * Argument to {@link defineApp}. The fields that survive into the
 * returned {@link App} are surfaced here with the same names. There are
 * no lifecycle hooks — setup is the factory body, teardown is `ensure(...)`.
 */
export interface DefineAppSpec {
  /** The declarative app manifest, imported from `app.json`. */
  manifest: AppManifest;
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
        `entry in the \`tools\` map passed to defineApp.`,
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
    throw new Error(`defineApp: spec.skill must be a string or SkillTemplateFn, got ${typeof skill}`);
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
 * Validate an app's declared shape and return the runtime {@link App}
 * object the framework will register and render against.
 *
 * Throws synchronously on the first validation failure with a message
 * naming the failing field and the violated rule.
 *
 * @example
 * ```ts
 * export function* createJiraApp(): Operation<App> {
 *   const cfgStore = yield* AppConfigStoreCtx.expect();
 *   const cfg = yield* cfgStore.get(manifest.name);
 *   if (!cfg) throw new Error('jira app requires config');
 *
 *   const source = new JiraSource(cfg);
 *   const searchTool = yield* createJiraSearchTool(cfg);
 *   const readTool = yield* createJiraReadTool(cfg);
 *
 *   return defineApp({
 *     manifest,
 *     source,
 *     tools: { jira_search: searchTool, jira_read: readTool },
 *     skill: skillTemplate,
 *   });
 * }
 * ```
 */
export function defineApp(spec: DefineAppSpec): App {
  // 1. Manifest top-level identifier.
  assertIdentifier(spec.manifest.name, 'manifest.name');

  // 2. App protocol version (if declared).
  assertAppProtocolVersion(spec.manifest.appProtocolVersion);

  // 3. Protocol substructure: name, useWhen, tools.
  assertIdentifier(spec.manifest.protocol.name, 'manifest.protocol.name');
  assertUseWhen(spec.manifest.protocol.useWhen);
  assertProtocolTools(spec.manifest.protocol.tools);

  // 4. Tools map coverage and name agreement.
  assertToolMapCoverage(spec.manifest.protocol.tools, spec.tools);

  // 5. Agent template double-emission guard.
  assertSkillTemplate(spec.skill);

  // Preserve `protocol.tools` insertion order in the runtime tools array
  // — that's the order the catalog renders and the order the spine
  // prefill receives schemas in. The framework relies on stable ordering
  // for the §10.1 snapshot gate.
  const tools = spec.manifest.protocol.tools.map((name) => spec.tools[name]);

  return {
    name: spec.manifest.name,
    manifest: spec.manifest,
    source: spec.source,
    tools,
    skill: spec.skill,
    examples: spec.examples,
    configSchema: spec.manifest.configSchema,
    hints: spec.hints ?? spec.manifest.hints,
    configFlow: spec.configFlow,
  };
}
