/**
 * How a view *accumulates* your events into renderable state.
 *
 * `reduce(state, event) → AppState` is a pure, node-free fold. It lives here —
 * not in the harness, not in a view — for two reasons:
 *   1. Only the small raw `WorkflowEvent` crosses a target boundary (IPC to
 *      the desktop window, wss to the browser); the growing transcript never
 *      does. So the fold has to happen in the *sink*. The harness stays a pure
 *      emitter; the renderer stays a pure sink.
 *   2. All three target views — the terminal (Ink), the desktop and the web
 *      (React) — import this ONE `reduce`. Node-free so every runtime can.
 *
 * `AppState` is a standard shape the generic auto-view knows how to render.
 * Grow it as your harness emits more events; add a `case` per event, keep the
 * fold immutable (new `Map` + new object only for what changed), and the views
 * update for free.
 */
import type { WorkflowEvent } from "./protocol.js";

export type Phase = "booting" | "ready" | "working" | "answered" | "error";

export type AgentStatus = "active" | "tool" | "done" | "failed";

export interface AgentView {
  id: number;
  parentId: number;
  status: AgentStatus;
  /** Accumulated streamed text (`agent:produce` deltas). */
  body: string;
  tokens: number;
  currentTool: string | null;
  toolCalls: number;
}

export interface AppState {
  phase: Phase;
  /** Insertion-ordered by spawn — the auto-view renders the tree from `parentId`. */
  agents: Map<number, AgentView>;
  answer: string;
  error: string | null;
  /** KV pressure for the gauge (from `agent:tick`). */
  kv: { used: number; total: number };
}

export const initialState: AppState = {
  phase: "booting",
  agents: new Map(),
  answer: "",
  error: null,
  kv: { used: 0, total: 0 },
};

export function reduce(s: AppState, ev: WorkflowEvent): AppState {
  switch (ev.type) {
    // ── your harness's own events ──
    case "ready":
      return s.phase === "booting" ? { ...s, phase: "ready" } : s;
    case "answer":
      return { ...s, phase: "answered", answer: ev.text };
    case "error":
      return { ...s, phase: "error", error: ev.message };

    // ── framework agent events (shared across every harness) ──
    case "agent:spawn": {
      const agents = new Map(s.agents);
      agents.set(ev.agentId, {
        id: ev.agentId,
        parentId: ev.parentAgentId,
        status: "active",
        body: "",
        tokens: 0,
        currentTool: null,
        toolCalls: 0,
      });
      return { ...s, phase: "working", agents };
    }
    case "agent:produce":
      return patch(s, ev.agentId, (a) => ({
        ...a,
        status: "active",
        currentTool: null,
        body: a.body + ev.text,
        tokens: a.tokens + ev.tokenCount,
      }));
    case "agent:tool_call":
      return patch(s, ev.agentId, (a) => ({
        ...a,
        status: "tool",
        currentTool: ev.tool,
        toolCalls: a.toolCalls + 1,
      }));
    case "agent:tool_result":
      return patch(s, ev.agentId, (a) => ({ ...a, status: "active", currentTool: null }));
    case "agent:return":
    case "agent:recovered":
      return patch(s, ev.agentId, (a) => ({ ...a, status: "done", body: a.body || ev.result }));
    case "agent:failed":
      return patch(s, ev.agentId, (a) => ({ ...a, status: "failed" }));
    case "agent:done":
      return patch(s, ev.agentId, (a) =>
        a.status === "active" || a.status === "tool" ? { ...a, status: "done" } : a,
      );
    case "agent:tick":
      return { ...s, kv: { used: ev.cellsUsed, total: ev.nCtx } };

    // agent:tool_progress / agent:tool_retry aren't shown in the austere view.
    default:
      return s;
  }
}

/** Immutably replace one agent — new `Map`, new object, only for the change. */
function patch(
  s: AppState,
  id: number,
  fn: (a: AgentView) => AgentView,
): AppState {
  const cur = s.agents.get(id);
  if (!cur) return s;
  const agents = new Map(s.agents);
  agents.set(id, fn(cur));
  return { ...s, agents };
}
