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

export type WorkflowEvent =
  // Forwarded verbatim from the agent pool (spawn / produce / return / …).
  | AgentEvent
  // Boot finished — the surface may accept a query.
  | { type: "ready" }
  // The answer for the last query.
  | { type: "answer"; text: string }
  // A recoverable error to show; the surface returns to accepting input.
  | { type: "error"; message: string };

export type Command =
  | { type: "submit_query"; query: string }
  | { type: "quit" };
