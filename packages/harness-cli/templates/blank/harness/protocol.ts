/**
 * The events this harness emits (↓) and the commands its surfaces send (↑).
 *
 * This union is YOURS — the harness owns it. Every target (cli · desktop ·
 * web) carries the same events over its binding, and the renderer folds them
 * into UI state via `reduce` (see `state.ts`). Grow these two types as your
 * harness grows; nothing else in the project needs to change when you do.
 *
 * `WorkflowEvent` re-exports the framework's `AgentEvent` because the harness
 * forwards raw agent-pool events straight through — the renderer reduces them
 * the same way in a terminal, an Electron window, or a browser tab.
 */
import type { AgentEvent } from "@lloyal-labs/lloyal-agents";

/**
 * The measured facts the boot surface renders — every line a runtime truth,
 * not a hardcoded string: the model's id + its on-disk size, which surface
 * mounted, and the AgentApps actually enabled (read from the registry). The
 * harness emits these on `ready`, so the header is identical in a terminal, an
 * Electron window, or a browser tab. (Tools' network-boundness + a trace path
 * are the next facts to surface — blank writes no trace and doesn't yet
 * introspect app entitlements, so it renders neither rather than a lie.)
 */
export interface BootFacts {
  model: { id: string; sizeBytes: number };
  surface: string;
  apps: string[];
}

export type WorkflowEvent =
  // Forwarded verbatim from the agent pool (spawn / produce / return / …).
  | AgentEvent
  // Boot finished — the surface may accept a query. Carries the measured facts.
  | { type: "ready"; facts: BootFacts }
  // The answer for the last query.
  | { type: "answer"; text: string }
  // A recoverable error to show; the surface returns to accepting input.
  | { type: "error"; message: string };

export type Command =
  | { type: "submit_query"; query: string }
  | { type: "quit" };
