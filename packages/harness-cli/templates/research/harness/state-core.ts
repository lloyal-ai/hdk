/**
 * Ink TUI — AppState shape.
 *
 * Populated by reducer.ts from StepEvent + AgentEvent. Components render
 * from this state and nothing else; no ambient ANSI, no side-effect logging.
 *
 * Layout model: each research agent owns a vertical `timeline` of items
 * (think blocks, tool calls, tool results, reports). Flat mode renders those
 * timelines as side-by-side columns; chain mode stacks them vertically.
 */

import type { Config, ConfigOrigin } from './config-types.js';

export type Phase = 'idle' | 'recon' | 'query' | 'plan' | 'research' | 'synth' | 'done';

/** Drives which top-level view the App renders. Distinct from `phase` —
 *  `phase` tracks the workflow progress; `uiPhase` tracks what the user
 *  currently interacts with. */
export type UiPhase =
  | 'boot'           // before config:loaded
  | 'downloading'    // model cache miss — spinner + per-file progress bars
  | 'loading'        // createContext / createReranker running; single spinner
  | 'composer'       // query input, source/mode editing
  | 'discovering'    // pre-flight recon agent probing sources; streams live
  | 'planning'       // planner running, spinner
  | 'plan_review'    // plan dialog visible, accept/edit/change-mode
  | 'clarifying'     // planner asked questions; composer takes the answer
  | 'research'       // column layout streaming
  | 'done'           // research complete, results visible, composer below
  | 'boot_error'     // download/load failed; recovery via /model or /quit
  | 'backend_pack_offer'; // CUDA pack available — Download / Not now dialog

/** User-facing reasoning mode. 'deep' == chain-shaped orchestration
 *  (sequential tasks that build on each other); 'flat' == parallel-shaped
 *  orchestration (orthogonal tasks running concurrently). One encoding
 *  everywhere — no 'chain' alias. */
export type Mode = 'flat' | 'deep';

/** One cited source, extracted CONSUMER-side from a tool result (the App
 *  Protocol prescribes no result schema). Web tools populate url/title/snippet
 *  today; image (og:image) + icon (favicon) arrive once the web app ≥1.2.0
 *  emits them. App-agnostic — corpus/other apps fill whatever subset applies. */
export interface SourceMeta {
  url?: string;
  title?: string;
  snippet?: string;
  /** og:image URL (or a local cache ref once the engine inlines it). */
  image?: string;
  /** favicon URL. */
  icon?: string;
  /** Display host, derived from url when present. */
  host?: string;
}

/** Per-agent chronological stream item. Column.tsx renders one component
 *  per kind. `live: true` on a think item means its body is currently
 *  streaming tokens and should render with a `▎` cursor. */
export type TimelineItem =
  | {
      kind: 'think';
      id: number;
      title: string;
      body: string;
      live: boolean;
      openedAt: number;
      closedAt: number | null;
    }
  | {
      kind: 'tool_call';
      id: number;
      tool: string;
      argsSummary: string;
    }
  | {
      kind: 'tool_result';
      id: number;
      tool: string;
      /** Optional back-reference to the tool_call id this result pairs with.
       *  Column renderer indents results under their matching call. */
      callId: number | null;
      byteLength: number;
      preview: string | null;
      hosts: string[];
      resultCount: number | null;
      /** Per-source citation metadata extracted from the tool's (free-form)
       *  result — the App Protocol prescribes no result schema, so this is a
       *  CONSUMER-side convention parsed in summarizeResult from known tool
       *  shapes (web_search/fetch_page already return url+title+snippet;
       *  fetch_page additionally emits og:image + favicon once web ≥1.2.0).
       *  Drives the per-page rows in the Sources ledger. Empty/undefined for
       *  tools that surface no per-source data (grep, corpus search). */
      sources?: SourceMeta[];
    }
  | {
      kind: 'report';
      id: number;
      body: string;
      tokenCount: number;
    };

export interface AgentRuntime {
  id: number;
  label: string;                          // "A0", "A1", …
  phase: 'idle' | 'thinking' | 'content' | 'tool' | 'done' | 'failed';
  tokenCount: number;
  toolCallCount: number;
  /** Wall-clock spawn time (ms) — start of this task's elapsed timer. */
  startedAt: number;
  /** Wall-clock completion time (ms), set when the agent reaches `done`
   *  (agent:return / agent:recovered). Null while running. Elapsed =
   *  (endedAt ?? now) − startedAt. */
  endedAt: number | null;
  /** Research task index this agent was spawned for. Null for synth. */
  taskIndex: number | null;
  /** Short task description, used in the column header when present. */
  taskDescription: string | null;
  /** Chain-mode dependency hint ("builds on Task 1"), shown in header. */
  dependencyHint: string | null;
  /** Id of the currently-live think item in `timeline`, or null. */
  currentThinkId: number | null;
  /** Id of the most recent tool_call, paired with its tool_result when one lands. */
  pendingToolCallId: number | null;
  /** Live park-and-retry state for the pending tool call (rate-limited
   *  provider; pool re-executes after the delay). Set on agent:tool_retry,
   *  cleared when the eventual tool_result lands. Renders as
   *  "rate-limited — retrying in ~Ns" so a waiting agent never reads as
   *  hung. */
  retry: { tool: string; retryAt: number; attempt: number } | null;
  /** Live post-</think> token buffer. Tokens stream into this between
   *  closing a think block and the next agent:tool_call / agent:report
   *  (the model is writing tool-call JSON — the terminal `report` tool's body
   *  lives inside that JSON, between `<parameter=result>` and `</parameter>`,
   *  raw and unescaped). Renderers extract the live report body straight from
   *  this buffer via `extractStreamingReport` below (consumed by Column.tsx's
   *  ContentStream and the desktop renderer's Work.tsx) — same
   *  marker-delimited technique the think block uses with `</think>`. Cleared
   *  on tool_call / report (those fire structured items instead). */
  contentBuffer: string;
  /** True while the agent is being force-recovered: `agent:done` fired (the
   *  agent stalled without a voluntary report) and `recoverInline` is streaming
   *  a forced report under an EAGER report grammar (no `<think>`/`</think>`).
   *  Routes those `agent:produce` tokens into `contentBuffer` (→ "Writing
   *  report") instead of a think block, so a recovered report isn't mislabeled
   *  as the agent "Thinking". Set on `agent:done`, cleared on
   *  `agent:return`/`agent:recovered`. See docs/upstream-issues.md. */
  recovering: boolean;
  /** Set when the agent's forced recovery FAILED (e.g. KV exhausted mid-report
   *  decode → `llama_decode failed`): no result was produced. Drives the terminal
   *  failure glyph (a cross) + frozen timer instead of an eternal "Writing report"
   *  spinner. Set on `agent:failed`; null otherwise. */
  failReason: string | null;
  /** Per-agent chronological stream. */
  timeline: TimelineItem[];
}

/** Live report markdown from a raw Hermes terminal-tool buffer:
 *  `…<parameter=result>\n<markdown>\n</parameter>…`. Raw <parameter> values are
 *  unescaped, so no decoding — same idea as streaming a think block until </think>.
 *  Returns the body (to the close marker, or buffer tail if not arrived), or null.
 *  Null until the open marker arrives — that gating is what keeps non-terminal
 *  tool-call args (search queries, URLs) from flashing as report prose. Callers
 *  branch on `recovering` first: a forced recovery streams raw prose with no
 *  envelope, so the buffer is used verbatim there. */
export function extractStreamingReport(buffer: string): string | null {
  const OPEN = '<parameter=result>';
  const i = buffer.indexOf(OPEN);
  if (i === -1) return null;
  let body = buffer.slice(i + OPEN.length);
  const c = body.indexOf('</parameter>');
  if (c !== -1) body = body.slice(0, c);
  return body.replace(/^\n/, '');
}

/** Append-only items rendered via Ink's `<Static>` so they get written to
 *  terminal scrollback once and never re-render.
 *
 *  Two kinds:
 *    - 'synth' — synth answer body (markdown), pushed at `synthesize:done`.
 *    - 'agent' — a finished research agent's panel snapshot, pushed at
 *      `agent:report`. The agent is also dropped from `researchAgentIds`
 *      at that point so Narrative stops rendering it live.
 *
 *  Why this matters: anything in the dynamic tree that isn't actively
 *  streaming triggers Ink's clearTerminal-on-overflow when the dynamic
 *  tree exceeds viewport, wiping scrollback. Pushing completed content
 *  to Static keeps the dynamic tree small and preserves scrollback. */
export type ScrollbackItem =
  | {
      key: string;
      kind: 'synth';
      /** Streamed body content (markdown). */
      body: string;
    }
  | {
      key: string;
      kind: 'agent';
      /** Snapshot of the agent's runtime state at agent:report time.
       *  Reducer state is immutable so this reference is stable —
       *  subsequent reductions create new AgentRuntime objects rather
       *  than mutating this one. */
      agent: AgentRuntime;
    };

export interface Pressure {
  pct: number;
  cellsUsed: number;
  nCtx: number;
}

export interface SynthState {
  open: boolean;
  buffer: string;
  done: boolean;
  stats: { tokens: number; toolCalls: number; ppl: number; timeMs: number } | null;
}

export interface OpTiming {
  label: string;
  tokens: number;
  detail: string;
  timeMs: number;
}

export interface DownloadStatus {
  id: string;
  label: string;
  got: number;
  total: number;
  done: boolean;
  /** True once `download:start` has fired for this entry. Distinguishes
   *  queued (planned but not begun) from active (bytes flowing). */
  started: boolean;
  /** Most recent URL the streamer is pulling from. Updates if a fallback
   *  kicks in (e.g., HF fails → R2 takes over mid-download). */
  url?: string;
}

export interface Toast {
  message: string;
  tone: 'info' | 'success' | 'warn' | 'error';
  /** Monotonic id so the view can animate/dismiss on change. */
  id: number;
}

/** A signed entitlement disclosed by an app's catalog metadata. The `key`
 *  maps to a privacy-label-style pill (network → Internet, etc.); `label`
 *  is the human-readable name carried alongside it. */
export interface AppEntitlement {
  key: string;
  label: string;
}

/** A view-ready descriptor for one installed (registry-enabled) AgentApp.
 *  Joins the app's local manifest with its signed catalog metadata
 *  (title/iconUrl/entitlements from apps.lloyal.ai) so the Settings drawer
 *  can render the app card, its tools, its config schema, and its current
 *  stored config. Built engine-side by main.ts and forwarded via the
 *  `apps:state` event; the reducer drops it whole into `AppState.apps`. */
export interface AppDescriptor {
  /** manifest.name (e.g. "web") — routing key + config-store key. */
  name: string;
  /** catalog metadata.title ?? manifest.hints?.shortName ?? protocol.name */
  title: string;
  /** manifest.hints?.description ?? protocol.useWhen */
  description: string;
  /** catalog metadata.iconUrl (apps.lloyal.ai asset) — else undefined → glyph. */
  iconUrl?: string;
  /** manifest.protocol.tools — the protocol's tool-name list. */
  tools: string[];
  /** catalog metadata.entitlements — capability keys
   *  (network|data-egress|local-files|credentials). */
  entitlements: string[];
  /** manifest.configSchema (JSON Schema) — fields render read-only this increment. */
  configSchema?: unknown;
  /** Current stored config from configStore.get(name). */
  config: Record<string, unknown>;
  /** Registry participation/enabled state. */
  enabled: boolean;
}

export interface AppState {
  query: string;
  warm: boolean;
  /** Top-level view state — drives App.tsx branching. */
  uiPhase: UiPhase;
  /** Payload for uiPhase 'backend_pack_offer'; null outside that phase. */
  backendPackOffer: {
    gpuName: string;
    sizeBytes: number;
    needsRuntime: boolean;
    runtimeSizeBytes: number;
    reasons: string[];
  } | null;
  /** Workflow phase — drives footer label, narrative visibility, etc. */
  phase: Phase;
  mode: Mode | null;
  plan: {
    intent: string;
    tasks: { description: string; app?: string }[];
    clarifyQuestions: string[];
    tokenCount: number;
    timeMs: number;
  } | null;
  agents: Map<number, AgentRuntime>;
  /** Research agents in spawn order — drives the column layout. */
  researchAgentIds: number[];
  /** Pre-flight recon agents in spawn order — drives the Discovering view.
   *  Kept separate from researchAgentIds so the two never cross-render; both
   *  reuse the same Column timeline machinery. Cleared when the planner's
   *  `query` event resets state for the run. */
  reconAgentIds: number[];
  /** Aggregate source count across all agents' tool_results (deduplicated
   *  by host within a result). Rendered in the footer. */
  sourceCount: number;
  synth: SynthState;
  answer: string | null;
  pressure: Pressure | null;
  timings: OpTiming[];
  startedAt: number;
  /** Accumulated milliseconds of pipeline-active time across the current
   *  query's lifecycle (planning + research + synth). Excludes plan-review
   *  dwell and composer idle. */
  pipelineElapsedMs: number;
  /** Timestamp (ms) of when the pipeline-active phase last resumed. Null
   *  while paused (plan_review, composer, done). Live elapsed = paused
   *  accumulator + (now - resume) while non-null. */
  pipelineResumedAt: number | null;
  /** Monotonic counters used by the reducer to assign stable ids. */
  nextTimelineId: number;
  nextLabelIdx: number;
  /** Set by spine:task in chain mode; consumed by the next research agent:spawn. */
  pendingTaskIndex: number | null;
  /** Set by spine:task; descriptor copied onto the next spawned agent. */
  pendingTaskDescription: string | null;
  /** Count of research-phase spawns seen (flat mode uses this to assign taskIndex). */
  researchSpawnCount: number;
  /** Authoritative fork count from `research:start` (= plan.tasks.length at the
   *  harness). The "Forked N agents" label prefers this over the live agent set
   *  or plan.tasks, which can be empty/late on the renderer side. 0 until research starts. */
  researchAgentCount: number;
  /** Merged config from CLI > env > file > default. Null until config:loaded. */
  config: Config | null;
  /** Per-field origin — used to flag secrets as `(env)` in the composer. */
  configOrigin: ConfigOrigin | null;
  /** Most recent transient toast (e.g. "saved → harness.json"). */
  toast: Toast | null;
  /** Prefill for the composer when arriving from `edit_plan`. */
  composerPrefill: string;
  /** Set when the planner asks clarifying questions. Drives the clarifying
   *  UI (questions stay visible above the composer while the user types
   *  the answer) and carries the original query so main.ts can re-run the
   *  planner with the Q&A as context. */
  clarifyContext: {
    originalQuery: string;
    questions: string[];
  } | null;
  /** Active downloads (model cache misses). Rendered under BootStatus
   *  while uiPhase === 'downloading'. Ordered by start time. */
  downloads: DownloadStatus[];
  /** Current "Loading weights…" / "Loading reranker…" label while
   *  uiPhase === 'loading'. Null while the phase is inactive. */
  loadingLabel: string | null;
  nextToastId: number;
  /** Append-only Static items (synth bodies). Persisted across queries so
   *  prior answers stay in scrollback after a follow-up query starts. */
  scrollback: ScrollbackItem[];
  /** Corpus indexing summary — displayed in the Composer's Corpus chip
   *  so the user can see how many files are in scope. Null until the
   *  first `corpus:indexed` event lands; refreshes on path changes. */
  corpusStatus: { fileCount: number; chunkCount: number } | null;
  /** Set when boot fails (model/reranker download or load error). Renders
   *  the error block + recovery prompt; the user can `/model <path>` or
   *  `/reranker <path>` to retry with a local .gguf, or `/quit`. `kind`
   *  determines which CTA is highlighted. Null once boot has progressed
   *  past the failure or the recovery succeeded. */
  bootError: { kind: 'llm' | 'reranker' | 'backend-pack'; message: string } | null;
  /** Per-app participation in the next query, keyed by `manifest.name`.
   *  `true` = included; `false` = configured-but-excluded (user opted out
   *  for this session); missing key = treat as included by default. The
   *  filter is applied at submit time in main.ts; `runQuery`'s
   *  `appFilter` opt carries the included-names array. Reset to `true`
   *  on reconfigure (`set_app_config`) — a config
   *  change is a strong signal of intent to use the app. */
  participation: Record<string, boolean>;
  /** Installed AgentApps surfaced into the renderer — one descriptor per
   *  registry-enabled app, joined with its signed catalog metadata. Drives
   *  the Settings drawer. Re-emitted whole on boot completion and after
   *  every registry enable/disable/config change. */
  apps: AppDescriptor[];
}

export const initialState: AppState = {
  query: '',
  warm: false,
  uiPhase: 'boot',
  backendPackOffer: null,
  phase: 'idle',
  mode: null,
  plan: null,
  agents: new Map(),
  researchAgentIds: [],
  reconAgentIds: [],
  sourceCount: 0,
  synth: { open: false, buffer: '', done: false, stats: null },
  answer: null,
  pressure: null,
  timings: [],
  startedAt: Date.now(),
  pipelineElapsedMs: 0,
  pipelineResumedAt: null,
  nextTimelineId: 0,
  nextLabelIdx: 0,
  pendingTaskIndex: null,
  pendingTaskDescription: null,
  researchSpawnCount: 0,
  researchAgentCount: 0,
  config: null,
  configOrigin: null,
  toast: null,
  composerPrefill: '',
  clarifyContext: null,
  downloads: [],
  loadingLabel: null,
  nextToastId: 0,
  scrollback: [],
  corpusStatus: null,
  bootError: null,
  participation: {},
  apps: [],
};
