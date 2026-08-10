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
 * are the next facts to surface — basic writes no trace and doesn't yet
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
  // A turn began. Emitted BEFORE any work, so the surface knows a new turn
  // started without having to infer it from the first `agent:spawn` — which is
  // both late and unable to tell a new turn's first agent from an extra agent
  // spawned inside the current one. `warm` is true when the session already has
  // a trunk, i.e. this turn DEEPENS the existing article rather than starting a
  // fresh one; the view uses it to decide between replacing and extending.
  | { type: "query"; text: string; warm: boolean }
  // The answer for the last query.
  | { type: "answer"; text: string }
  // A recoverable error to show; the surface returns to accepting input.
  | { type: "error"; message: string };

export type Command =
  | { type: "submit_query"; query: string }
  | { type: "quit" };
