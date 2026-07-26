/**
 * The shared React view — BOTH desktop and web mount this ONE component, and it
 * folds the SAME node-free `reduce` (`harness/state.ts`) that the cli's Ink view
 * does. Two runtimes (Ink · React), one `reduce`, one rich research `AppState`.
 *
 * It is transport-agnostic: it only reads `window.harness` — a bridge injected
 * by desktop's preload (contextBridge over IPC) or web's boot (`connectWss` over
 * a socket). Austere on purpose — it renders the same slice the cli's Ink view
 * does: the phase, the live research agents (glyph · label · task · tokens ·
 * tools), a KV pressure gauge, the streaming synth answer, and one input that
 * dispatches a query. Like the cli view it auto-accepts the planner's plan
 * (there is no plan-review editor here), so a query flows recon → plan → agents
 * → synth end-to-end. This is the floor — grow it into your product's UI (or
 * bring your own app); the harness never changes.
 *
 * SNAPSHOT: reasoning.run @ 0.8.0
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { reduce, initialState, type AppState, type AgentRuntime } from "../../harness/state.js";
import type { WorkflowEvent, Command } from "../../harness/protocol.js";

declare global {
  interface Window {
    harness: {
      onEvent(cb: (frame: { seq: number; ev: WorkflowEvent }) => void): () => void;
      send(command: Command): void;
      requestSnapshot(): Promise<{ state: AppState; seq: number }>;
    };
  }
}

/** Terminal glyph per agent phase — the same vocabulary the Ink view uses. */
const glyph = (p: AgentRuntime["phase"]): string =>
  p === "done" ? "✓" : p === "failed" ? "✗" : p === "tool" ? "◍" : p === "idle" ? "·" : "●";

/** Where the input line is offered — the harness is idle and awaiting a query. */
const CAN_INPUT = new Set<AppState["uiPhase"]>(["boot", "composer", "done", "clarifying"]);

export function HarnessApp() {
  const [state, setState] = useState<AppState>(initialState);
  const seqRef = useRef(-1);
  const [query, setQuery] = useState("");
  const acceptedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    let seeded = false;
    // Subscribe FIRST so no frame is missed, but hold frames until the snapshot
    // lands — applying them live would let a frame advance `seqRef` and then be
    // overwritten by an older snapshot cut (a lost-event gap on reload).
    const pending: { seq: number; ev: WorkflowEvent }[] = [];
    const apply = (frame: { seq: number; ev: WorkflowEvent }): void => {
      if (frame.seq <= seqRef.current) return;
      seqRef.current = frame.seq;
      setState((s) => reduce(s, frame.ev));
    };
    // Seed from `base`@`baseSeq`, then fold any buffered frames newer than the cut
    // — computed OUTSIDE the updater so React StrictMode's double-invoke is safe.
    const seed = (base: AppState, baseSeq: number): void => {
      if (!alive || seeded) return;
      let next = base;
      let cur = baseSeq;
      for (const f of pending) {
        if (f.seq <= cur) continue;
        cur = f.seq;
        next = reduce(next, f.ev);
      }
      pending.length = 0;
      seqRef.current = cur;
      seeded = true;
      setState(next);
    };
    const off = window.harness.onEvent((frame) => {
      if (seeded) apply(frame);
      else pending.push(frame);
    });
    window.harness
      .requestSnapshot()
      .then((snap) => seed(snap.state, snap.seq))
      // No snapshot (e.g. the host is unreachable): seed from the initial state so
      // the stream is never stuck buffering, and replay whatever we've buffered.
      .catch(() => seed(initialState, -1));
    return () => {
      alive = false;
      off();
    };
  }, []);

  // Auto-accept the planner's plan — this austere view has no plan-review editor,
  // so a query flows straight through to research. `acceptedRef` de-bounces the
  // one transition into `plan_review` (mirrors the cli view).
  useEffect(() => {
    if (state.uiPhase === "plan_review" && !acceptedRef.current) {
      acceptedRef.current = true;
      window.harness.send({ type: "accept_plan" });
    }
    if (state.uiPhase !== "plan_review") acceptedRef.current = false;
  }, [state.uiPhase]);

  const submit = (): void => {
    const q = query.trim();
    if (!q) return;
    if (state.uiPhase === "clarifying") {
      window.harness.send({ type: "submit_clarification", answer: q });
    } else {
      window.harness.send({ type: "submit_query", query: q, mode: "flat" });
    }
    setQuery("");
  };

  // Recon + research agents (skip the tool-less synth agent — taskIndex null).
  const agents: AgentRuntime[] = [...state.agents.values()].filter((a) => a.taskIndex !== null);

  // The streaming answer: the live synth buffer, else the finalized answer, else
  // the most recent synth body pushed to scrollback.
  const lastSynth = [...state.scrollback].reverse().find((s) => s.kind === "synth");
  const streaming =
    (state.synth.open && state.synth.buffer) ||
    state.answer ||
    (lastSynth && lastSynth.kind === "synth" ? lastSynth.body : "");

  const kvPct =
    state.pressure && state.pressure.nCtx > 0
      ? Math.min(100, Math.round((100 * state.pressure.cellsUsed) / state.pressure.nCtx))
      : null;

  const canInput = CAN_INPUT.has(state.uiPhase);

  return (
    <div style={S.page}>
      <div style={S.head}>
        __NAME__ · {state.phase}
        {state.uiPhase !== state.phase ? ` · ${state.uiPhase}` : ""}
        {kvPct !== null && ` · kv ${kvPct}%`}
      </div>

      {agents.map((a) => (
        <div key={a.id} style={{ ...S.agent, opacity: a.phase === "done" ? 0.65 : 1 }}>
          <div style={S.meta}>
            {glyph(a.phase)} {a.label}
            {a.taskDescription ? ` · ${a.taskDescription}` : ""} · {a.tokenCount} tok
            {a.toolCallCount > 0 ? ` · ${a.toolCallCount} tools` : ""}
          </div>
        </div>
      ))}

      {state.uiPhase === "clarifying" && state.plan?.clarifyQuestions?.length ? (
        <div style={S.clarify}>
          <div style={S.clarifyHead}>The planner needs to clarify:</div>
          {state.plan.clarifyQuestions.map((q, i) => (
            <div key={i}>
              {i + 1}. {q}
            </div>
          ))}
        </div>
      ) : null}

      {streaming ? <div style={S.answer}>{streaming}</div> : null}
      {state.bootError && (
        <div style={S.error}>
          boot error ({state.bootError.kind}): {state.bootError.message}
        </div>
      )}
      {state.toast?.tone === "error" && <div style={S.error}>error: {state.toast.message}</div>}

      {canInput && (
        <div style={S.composer}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder={
              state.uiPhase === "clarifying" ? "Answer the planner…" : "Ask something…"
            }
            style={S.input}
          />
          <button type="button" onClick={submit} style={S.send}>
            Send
          </button>
        </div>
      )}
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  page: { font: "14px/1.55 ui-sans-serif, system-ui, sans-serif", color: "#e6e9ef", padding: 20, maxWidth: 820, margin: "0 auto" },
  head: { opacity: 0.55, fontSize: 12, marginBottom: 14, letterSpacing: 0.3 },
  agent: { borderLeft: "2px solid #2b3140", paddingLeft: 12, margin: "8px 0" },
  meta: { fontSize: 13 },
  clarify: { margin: "10px 0", color: "#e3c04a" },
  clarifyHead: { marginBottom: 4 },
  answer: { marginTop: 16, whiteSpace: "pre-wrap", lineHeight: 1.6, color: "#cfe6ff" },
  error: { marginTop: 16, color: "#ff7a7a" },
  composer: { display: "flex", gap: 8, marginTop: 22 },
  input: { flex: 1, padding: "9px 12px", background: "#12151c", color: "#e6e9ef", border: "1px solid #2b3140", borderRadius: 8, outline: "none" },
  send: { padding: "9px 18px", background: "#3b4a6b", color: "#fff", border: 0, borderRadius: 8, cursor: "pointer" },
};
