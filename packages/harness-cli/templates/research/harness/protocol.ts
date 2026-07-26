/**
 * reasoning.run/protocol — the harness's wire vocabulary.
 *
 * Its `WorkflowEvent` union (down) + `Command` union (up) — the two halves of
 * the headless interface `harness(ctx, events, commands)` speaks — plus the
 * config *schema* a runner resolves and hands the harness. A host or surface
 * imports these to speak the protocol without depending on the UI.
 *
 * TYPES ONLY — this surface must stay `node:`-free so a browser/renderer surface
 * can import it for the plan/event types. The config *loaders*
 * (`loadConfig`/`saveConfig`) deliberately stay runner-side in `./tui-ink/config`
 * — they touch `node:fs`, and only the in-package runner (`runMain`) calls them.
 */
export type { StepEvent, WorkflowEvent } from "./events.js";
export type { Command } from "./commands.js";
export type {
  Config,
  ConfigSources,
  ConfigDefaults,
  ConfigModel,
  ConfigOrigin,
  LoadedConfig,
  CliOverrides,
  SaveResult,
} from "./config-types.js";
