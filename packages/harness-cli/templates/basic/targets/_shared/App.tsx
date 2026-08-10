/**
 * The shared React view — BOTH desktop and web mount this ONE component, and it
 * folds the SAME node-free `reduce` (`harness/state.ts`) that the cli's Ink view
 * does. Two runtimes (Ink · React), one `reduce`.
 *
 * It's styled as a Wikipedia article, because `basic` ships the `lloyal/wikipedia`
 * app: a Contents rail, a serif title + editorial prose, the fetched articles
 * floated as captioned figures, and a collapsible research log where each agent's
 * thinking and findings stream in. Swap the app and the wiki-specific bits (source
 * figures) gracefully empty; the layout + the streaming log stay generic. This is
 * the floor — reskin it into your product's own look.
 *
 * It's transport-agnostic: it reads only `window.harness`, a bridge injected by
 * desktop's preload (IPC) or web's boot (`connectWss`).
 */
import "./app.css";
import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  reduce,
  initialState,
  formatSize,
  cleanNarration,
  reportBody,
  extractStreamingReport,
  wikipediaSources,
  reportHeadings,
  isResearchAgent,
  isLiveAgent,
  type AppState,
  type AgentView,
  type WikiSource,
} from "../../harness/state.js";
import type { WorkflowEvent, Command } from "../../harness/protocol.js";
import { Markdown } from "./Markdown.js";

declare global {
  interface Window {
    harness: {
      onEvent(cb: (frame: { seq: number; ev: WorkflowEvent }) => void): () => void;
      send(command: Command): void;
      requestSnapshot(): Promise<{ state: AppState; seq: number }>;
    };
  }
}

const scrollTo = (id: string): void =>
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** A fetched article as a Wikipedia-style figure, floated into the prose. */
function SourceFigure({ s }: { s: WikiSource }): ReactElement {
  return (
    <figure className="wiki-fig">
      {s.thumbnail && <img src={s.thumbnail} alt="" loading="lazy" />}
      <figcaption>
        <a href={s.url || undefined} target="_blank" rel="noopener noreferrer">
          {s.title}
        </a>
        {s.snippet && ` — ${s.snippet}`}
      </figcaption>
    </figure>
  );
}

/** One agent in the research log: a collapsible row (Wikipedia [show]/[hide]).
 *  Collapsed shows a live one-line preview; expanded reveals the streaming
 *  thinking and, once the agent writes its terminal report, the findings — both
 *  in a bounded, scrollable box pinned to the newest line. */
function AgentEntry({ a }: { a: AgentView }): ReactElement {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const reasoning = cleanNarration(a.body);
  const report = extractStreamingReport(a.body); // null until the report tool call starts
  const live = isLiveAgent(a);
  const lastLine = (t: string): string => t.split("\n").filter(Boolean).slice(-1)[0] ?? "";
  const preview = report !== null ? lastLine(report) || "writing report…" : lastLine(reasoning) || "thinking…";
  const status =
    a.status === "done"
      ? "done"
      : a.status === "failed"
        ? "failed"
        : a.status === "tool" && a.currentTool
          ? a.currentTool
          : report !== null
            ? "writing report"
            : "reading";
  // Keep the expanded box pinned to the newest line while it streams.
  useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [reasoning, report, open]);

  return (
    <div className="wiki-log-entry">
      <div className="wiki-log-head">
        <span className={`wiki-dot wiki-dot--${a.status}`} />
        <span className="wiki-log-title">Agent {a.id}</span>
        <span className="wiki-log-status">{status}</span>
        <button type="button" className="wiki-toggle" onClick={() => setOpen((o) => !o)}>
          [{open ? "hide" : "show"}]
        </button>
      </div>
      {!open ? (
        <div className="wiki-log-preview">{preview}</div>
      ) : (
        <div className="wiki-log-body" ref={bodyRef}>
          {reasoning && (
            <p className="wiki-log-think">
              {reasoning}
              {live && report === null && <span className="wiki-caret">▍</span>}
            </p>
          )}
          {report !== null && (
            <div className="wiki-log-report">
              <div className="wiki-log-report-label">Findings</div>
              <div className="md">
                <Markdown text={report} />
              </div>
              {live && <span className="wiki-caret">▍</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function HarnessApp(): ReactElement {
  const [state, setState] = useState<AppState>(initialState);
  const seqRef = useRef(-1);
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState("");

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
      .catch(() => seed(initialState, -1));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const submit = (): void => {
    const q = query.trim();
    if (!q) return;
    window.harness.send({ type: "submit_query", query: q });
    setTopic(q);
    setQuery("");
  };

  const agents: AgentView[] = [...state.agents.values()];
  const research = agents.filter(isResearchAgent);
  // Agents accumulate across turns (they are the composition history), so the
  // synth must be picked from THIS turn — `find` over the whole map would pin it
  // to the first turn's synth forever, and a follow-up would never render.
  // `isResearchAgent` is "has recorded a tool call", so a research agent looks
  // synth-like until its first call: take the LAST match in this turn, which is
  // the real synth once it exists and is harmless before then.
  const thisTurn = agents.filter((a) => a.turn === state.turn);
  const synth = [...thisTurn].reverse().find((a) => !isResearchAgent(a));
  const live = thisTurn.filter((a) => isLiveAgent(a) && isResearchAgent(a));
  // The log keeps every turn's agents as the record of how this page was
  // composed — but calling the finished ones "reading" is false the moment a
  // follow-up starts, so the present tense counts only what is live.
  const plural = (n: number): string => (n === 1 ? "" : "s");
  const researchNote =
    live.length > 0
      ? `${live.length} agent${plural(live.length)} reading Wikipedia in parallel.`
      : `${research.length} agent${plural(research.length)} researched this page.`;
  const sources = wikipediaSources(agents);
  const working = state.phase === "working";
  // The article prose = the final answer, or the synth's report streaming in
  // (the synth writes free text: `reportBody` strips its `<think>` reasoning).
  const liveSynth = synth && synth.body.includes("</think>") ? reportBody(synth.body) : "";
  const report = state.answer || liveSynth;
  // While the synth is still thinking (before it starts the report), show its
  // reasoning streaming so the report pane is alive, not a static spinner.
  const synthThinking = synth && !report ? cleanNarration(synth.body) : "";
  const headings = report ? reportHeadings(report) : [];
  // `state.topic` is authoritative (it survives a reload and is the same on
  // every surface); the local one only covers the instant before `query` lands.
  const title = state.topic || topic || "__NAME__";

  return (
    <div className="wiki">
      <header className="wiki-top">
        <div className="wiki-brand">
          <span className="wiki-brand-name">__NAME__</span>
          <span className="wiki-brand-sub">
            {state.boot
              ? `${state.boot.model.id} · ${formatSize(state.boot.model.sizeBytes)} · ${state.boot.surface}`
              : state.phase}
            {state.kv.total > 0 && ` · kv ${Math.round((100 * state.kv.used) / state.kv.total)}%`}
          </span>
        </div>
        <form
          className="wiki-search"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Wikipedia…"
            disabled={working}
          />
          <button type="submit" disabled={working || !query.trim()}>
            {working ? "Researching…" : "Ask"}
          </button>
        </form>
      </header>

      <div className="wiki-cols">
        <nav className="wiki-toc" aria-label="Contents">
          <div className="wiki-toc-head">Contents</div>
          <ul>
            <li>
              <button type="button" onClick={() => scrollTo("top")}>
                (Top)
              </button>
            </li>
            {headings.map((h, i) => (
              <li key={i} className={`wiki-toc-l${h.level}`}>
                <button type="button" onClick={() => scrollTo(h.slug)}>
                  {h.text}
                </button>
              </li>
            ))}
            {research.length > 0 && (
              <li>
                <button type="button" onClick={() => scrollTo("research")}>
                  Research
                </button>
              </li>
            )}
            {sources.length > 0 && (
              <li>
                <button type="button" onClick={() => scrollTo("sources")}>
                  Sources
                </button>
              </li>
            )}
          </ul>
        </nav>

        <main className="wiki-article" id="top">
          <h1 className="wiki-title">{title}</h1>
          <hr className="wiki-rule" />

          {/* Fetched articles as a Wikipedia-style image gallery — a wrapping
              grid of uniform cards, so they read as a gallery, not a stack. */}
          {sources.length > 0 && (
            <div className="wiki-figs">
              {sources.map((s) => (
                <SourceFigure key={s.url || s.title} s={s} />
              ))}
            </div>
          )}

          {report ? (
            <div className="wiki-prose md">
              <Markdown text={report} />
            </div>
          ) : synth ? (
            <div>
              <p className="wiki-lead">Writing the report…</p>
              {synthThinking && (
                <p className="wiki-synth-think">
                  {synthThinking}
                  <span className="wiki-caret">▍</span>
                </p>
              )}
            </div>
          ) : working ? (
            <p className="wiki-lead">Researching Wikipedia… The report will appear here.</p>
          ) : (
            <p className="wiki-lead">Ask a question above to research it across Wikipedia.</p>
          )}

          {state.error && <p className="wiki-error">Error: {state.error}</p>}

          {research.length > 0 && (
            <section id="research" className="wiki-log">
              <h2>Research</h2>
              <p className="wiki-log-note">
                {researchNote} Expand an agent to follow its reasoning and findings.
              </p>
              {research.map((a) => (
                <AgentEntry key={a.id} a={a} />
              ))}
            </section>
          )}

          {sources.length > 0 && (
            <section id="sources" className="wiki-refs">
              <h2>Sources</h2>
              <ol>
                {sources.map((s, i) => (
                  <li key={i}>
                    <a href={s.url || undefined} target="_blank" rel="noopener noreferrer">
                      {s.title}
                    </a>
                    {s.url && <span className="wiki-refs-host"> — {hostOf(s.url)}</span>}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
