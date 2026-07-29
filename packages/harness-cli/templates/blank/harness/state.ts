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
import type { WorkflowEvent, BootFacts } from "./protocol.js";

export type Phase = "booting" | "ready" | "working" | "answered" | "error";

/** Human-readable file size — the boot header renders the model's measured bytes.
 *  `sizeBytes` is best-effort (0 when the stat failed), so 0/unknown reads as
 *  "unknown" rather than a fabricated "1 KB". */
export function formatSize(bytes: number): string {
  if (bytes <= 0) return "unknown";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

export type AgentStatus = "active" | "tool" | "done" | "failed";

/** One tool invocation, paired with its result — the atomic unit the view
 *  renders as a chip (a call in flight has `result: null`). Built from the
 *  structured `agent:tool_call` / `agent:tool_result` events, NOT by parsing the
 *  model's `<tool_call>` XML out of the stream. `args` is the raw JSON string
 *  the event carries; `toolArgSummary` formats it for display. */
export interface ToolStep {
  tool: string;
  args: string;
  result: string | null;
}

export interface AgentView {
  id: number;
  parentId: number;
  status: AgentStatus;
  /** Accumulated streamed text (`agent:produce` deltas). Includes the model's
   *  `<think>` / `<tool_call>` markup verbatim — `cleanNarration` strips it for
   *  display (tools render as chips from `tools`, not from this text). */
  body: string;
  tokens: number;
  currentTool: string | null;
  toolCalls: number;
  /** Tool calls in order, each paired with its result — see `ToolStep`. */
  tools: ToolStep[];
}

export interface AppState {
  phase: Phase;
  /** Measured boot facts for the header — null until `ready` lands. */
  boot: BootFacts | null;
  /** Insertion-ordered by spawn — the auto-view renders the tree from `parentId`. */
  agents: Map<number, AgentView>;
  answer: string;
  error: string | null;
  /** KV pressure for the gauge (from `agent:tick`). */
  kv: { used: number; total: number };
}

export const initialState: AppState = {
  phase: "booting",
  boot: null,
  agents: new Map(),
  answer: "",
  error: null,
  kv: { used: 0, total: 0 },
};

export function reduce(s: AppState, ev: WorkflowEvent): AppState {
  switch (ev.type) {
    // ── your harness's own events ──
    case "ready":
      // Boot facts land here — the view renders the header from `s.boot`.
      return { ...s, phase: s.phase === "booting" ? "ready" : s.phase, boot: ev.facts };
    case "answer":
      return { ...s, phase: "answered", answer: ev.text, error: null };
    case "error":
      return { ...s, phase: "error", error: ev.message, answer: "" };

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
        tools: [],
      });
      // A new query begins — clear the prior answer/error so it doesn't
      // linger while this run produces.
      return { ...s, phase: "working", agents, answer: "", error: null };
    }
    case "agent:produce":
      return patch(s, ev.agentId, (a) => ({
        ...a,
        status: "active",
        currentTool: null,
        body: a.body + ev.text,
        // `tokenCount` is the agent's running TOTAL, not a per-delta count —
        // take the latest, don't sum (summing cumulatives is quadratic).
        tokens: ev.tokenCount,
      }));
    case "agent:tool_call":
      return patch(s, ev.agentId, (a) => ({
        ...a,
        status: "tool",
        currentTool: ev.tool,
        toolCalls: a.toolCalls + 1,
        tools: [...a.tools, { tool: ev.tool, args: ev.args, result: null }],
      }));
    case "agent:tool_result":
      return patch(s, ev.agentId, (a) => ({
        ...a,
        status: "active",
        currentTool: null,
        // Fill the most recent in-flight call for this tool with its result.
        tools: fillResult(a.tools, ev.tool, ev.result),
      }));
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

/** Fill the last in-flight (`result === null`) call of `tool` with `result`. */
function fillResult(tools: ToolStep[], tool: string, result: string): ToolStep[] {
  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i].tool === tool && tools[i].result === null) {
      const next = tools.slice();
      next[i] = { ...tools[i], result };
      return next;
    }
  }
  return tools;
}

// ── display helpers (pure; the cli + desktop/web views share them) ──

const truncate = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

/**
 * The narration to *show* — the model's prose with its `<tool_call>` blocks and
 * `<think>` tags stripped. Tool calls render as chips (from `tools`), so their
 * raw XML is noise here; a trailing unterminated `<tool_call>` (mid-stream) is
 * dropped too. `<think>` bodies are kept (they're the reasoning) minus the tags.
 */
export function cleanNarration(body: string): string {
  return body
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_call>[\s\S]*$/g, "")
    .replace(/<\/?think>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A one-line `key: value · key: value` summary of a tool call's JSON args. */
export function toolArgSummary(args: string): string {
  try {
    const obj = JSON.parse(args) as Record<string, unknown>;
    return Object.entries(obj)
      .map(([k, v]) => `${k}: ${truncate(String(v), 40)}`)
      .join(" · ");
  } catch {
    return truncate(args.trim(), 60);
  }
}

/** Compact result meta: "…" while in flight, "N results" for a JSON array,
 *  else an approximate size — the same idea as Artifact's row meta. */
export function resultMeta(result: string | null): string {
  if (result === null) return "…";
  try {
    const parsed = JSON.parse(result) as unknown;
    if (Array.isArray(parsed)) return `${parsed.length} result${parsed.length === 1 ? "" : "s"}`;
  } catch {
    // not JSON — fall through to a size estimate
  }
  const kb = result.length / 1000;
  return kb >= 1 ? `${kb.toFixed(1)} kb` : `${result.length} chars`;
}
