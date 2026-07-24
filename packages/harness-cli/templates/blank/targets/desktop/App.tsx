/**
 * The shared React view — BOTH desktop and web mount this ONE component, and it
 * folds the SAME node-free `reduce` (`harness/state.ts`) that the cli's Ink view
 * does. Two runtimes (Ink · React), one `reduce`.
 *
 * It is transport-agnostic: it only reads `window.harness` — a bridge injected
 * by desktop's preload (contextBridge over IPC) or web's boot (`connectWss` over
 * a socket). Austere on purpose: a phase line, a card per agent (streamed body +
 * status + token count), the answer, and one input that dispatches a query. This
 * is the floor — grow it into your product's UI (or bring your own app).
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { reduce, initialState, type AppState, type AgentView } from "../../harness/state.js";
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

export function HarnessApp() {
  const [state, setState] = useState<AppState>(initialState);
  const seqRef = useRef(-1);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let alive = true;
    // Seed from the consistent-cut snapshot, then apply only newer events.
    void window.harness.requestSnapshot().then((snap) => {
      if (!alive) return;
      seqRef.current = snap.seq;
      setState(snap.state);
    });
    const off = window.harness.onEvent(({ seq, ev }) => {
      if (seq <= seqRef.current) return;
      seqRef.current = seq;
      setState((s) => reduce(s, ev));
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const submit = (): void => {
    const q = query.trim();
    if (!q) return;
    window.harness.send({ type: "submit_query", query: q });
    setQuery("");
  };

  const agents: AgentView[] = [...state.agents.values()];
  return (
    <div style={S.page}>
      <div style={S.head}>
        __NAME__ · {state.phase}
        {state.kv.total > 0 && ` · kv ${Math.round((100 * state.kv.used) / state.kv.total)}%`}
      </div>
      {agents.map((a) => (
        <div key={a.id} style={{ ...S.agent, opacity: a.status === "done" ? 0.65 : 1 }}>
          <div style={S.meta}>
            agent {a.id} · {a.currentTool ? `⚙ ${a.currentTool}` : a.status} · {a.tokens} tok
          </div>
          <div style={S.body}>{a.body}</div>
        </div>
      ))}
      {state.answer && <div style={S.answer}>{state.answer}</div>}
      {state.error && <div style={S.error}>{state.error}</div>}
      <div style={S.composer}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="Ask something…"
          style={S.input}
        />
        <button type="button" onClick={submit} style={S.send}>
          Send
        </button>
      </div>
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  page: { font: "14px/1.55 ui-sans-serif, system-ui, sans-serif", color: "#e6e9ef", padding: 20, maxWidth: 820, margin: "0 auto" },
  head: { opacity: 0.55, fontSize: 12, marginBottom: 14, letterSpacing: 0.3 },
  agent: { borderLeft: "2px solid #2b3140", paddingLeft: 12, margin: "10px 0" },
  meta: { fontSize: 12, opacity: 0.55 },
  body: { whiteSpace: "pre-wrap" },
  answer: { marginTop: 16, whiteSpace: "pre-wrap", lineHeight: 1.6 },
  error: { marginTop: 16, color: "#ff7a7a" },
  composer: { display: "flex", gap: 8, marginTop: 22 },
  input: { flex: 1, padding: "9px 12px", background: "#12151c", color: "#e6e9ef", border: "1px solid #2b3140", borderRadius: 8, outline: "none" },
  send: { padding: "9px 18px", background: "#3b4a6b", color: "#fff", border: 0, borderRadius: 8, cursor: "pointer" },
};
