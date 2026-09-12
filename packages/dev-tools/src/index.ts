/**
 * The dev pane's node-free core: the event fold that turns a harness's bus
 * stream into renderable pane state, the declarative control table a template
 * contributes, and the provenance/tier vocabulary.
 *
 * Everything here is DERIVED from events the harness already emits — the pane
 * never asks the harness for anything it doesn't already say. Events arrive
 * structurally (`{ type: string }` + fields); this module reads only fields
 * whose emitters are versioned alongside it (the template protocols and the
 * agents package), and ignores what it doesn't know.
 *
 * @category DevTools
 */
import type { ConfigOriginValue } from '@lloyal-labs/rig';

export type { ConfigOriginValue } from '@lloyal-labs/rig';

/** A structural bus event — the pane subscribes to the SAME stream the app
 *  view folds, and narrows by `type` per field it reads. */
export type DevEvent = { type: string } & Record<string, unknown>;

/** The pane's tabs. `prompt` arrives with the trace transport — the model
 *  knows the name so the tab strip can reserve it, but v1 never activates it. */
export type PaneTab = 'timeline' | 'sources' | 'settings';

/**
 * One template-contributed Settings control — pure DATA, no components. The
 * pane renders a segmented control and dispatches
 * `{ type: command, [field]: value }` on click; the template's reducer and
 * handlers already know that command (it is the same one its composer sends).
 */
export interface DevControl {
  /** The config path this control edits (display + provenance lookup),
   *  e.g. `defaults.effort`. */
  key: string;
  /** The `ConfigOrigin` field carrying this key's provenance, e.g. `effort`
   *  is not tracked — use the origin key that is (`reasoningMode`), or omit. */
  originKey?: string;
  /** The values the segmented control offers, in display order. */
  values: readonly string[];
  /** The command `type` dispatched on selection. */
  command: string;
  /** The command field carrying the selected value. */
  field: string;
  /** How to draw the choice. `segmented` (default) is the button row;
   *  `slider` is the same ordered `values`, stepped — right when they form a
   *  scale rather than a set, so the ordering is the information. Both
   *  dispatch the identical command, so this changes the picture only. */
  render?: 'segmented' | 'slider';
  /** One clause shown beside the control, e.g. `applies next run`. */
  note?: string;
  /** Read the current value out of the live config object. */
  read: (config: Record<string, unknown>) => string | undefined;
}

/** A clarify exchange on the planner's lane — the planner waiting on the
 *  USER, rendered with the same call/wait/answer grammar a tool wait uses. */
export interface ClarifyExchange {
  questions: string[];
  askedAt: number;
  answeredAt: number | null;
}

/** One lane row of the timeline: an agent's span, derived live from the bus. */
export interface AgentLane {
  agentId: number;
  parentAgentId: number | null;
  /** The phase label current at spawn — from the harness's own
   *  {@link RunFraming} declaration; null when its wire marks nothing.
   *  Never guessed. */
  role: string | null;
  /** Agent ids whose completion gated this spawn — the DAG's dependency
   *  edges, from the orchestrator via `agent:spawn.after`. Never inferred. */
  after?: number[];
  /** Tokens already resident on this lane's prefix at its fork — snapshotted
   *  the moment the spawn folds, never reconstructed. Top-level: the trunk
   *  inheritance + spine growth so far. Recursive: the parent lane's own
   *  inheritance + what it had produced by then (its suffix is not counted —
   *  an honest undercount). Absent when the pane cannot attribute the fork
   *  (a pre-spine spawn such as a planner). */
  inherited?: number;
  spawnedAt: number;
  doneAt: number | null;
  /** Terminal outcome, when known. `failed` carries the reason. */
  outcome: 'running' | 'done' | 'recovered' | 'failed';
  failReason?: string;
  tokenCount: number;
  /** tool name → the call currently in flight (cleared on result). */
  inflightTool: string | null;
  /** The agent's delivered report — `agent:return` (voluntary) or
   *  `agent:recovered` (extracted). Null until one arrives. */
  report: string | null;
  reportSource: 'voluntary' | 'recovery' | null;
  /** When the pool reclaimed the branch's KV (`branch:prune` mirror). */
  prunedAt: number | null;
  /** The pool's drop reason (`pool:agentDrop` mirror) — richer than the
   *  bus `agent:failed` reason. */
  dropReason: string | null;
  /** Set on the planner while it waits on the user (research's clarify). */
  clarify: ClarifyExchange | null;
  /** The compiled prompt that seeded this agent — the `prompt:format`
   *  mirror (role agentSuffix), attributed by its agentId stamp. What the
   *  model ACTUALLY saw, post-template, post-tool-schemas. */
  prompt: { text: string; tokenCount: number } | null;
  /** Per-token epistemics samples (`agent:produce` under the dev gate),
   *  time-anchored to the lane's span. h = model entropy in nats (how open
   *  the next-token choice was, over the full vocabulary); s = model
   *  surprisal in nats (−ln p of the token actually picked). Past the cap
   *  the array is decimated in place — pairs averaged (h) / maxed (s) — so
   *  the WHOLE run stays covered rather than a sliding recent window.
   *  Empty when tracing is off. */
  epistemics: EpiSample[];
  /** Running NLL accumulator over produced tokens — never decimated, so
   *  {@link lanePpl} stays exact for the lane's full lifetime. */
  nllSum: number;
  nllCount: number;
}

/** One per-token epistemics sample, stamped at fold time. */
/** One host-resources sample on the wire — produced by the node entry's
 *  sampler (`@lloyal-labs/dev-tools/node`), folded into {@link PaneModel.host}.
 *  Declared here so a node-free protocol can name it type-only. */
export interface HostResourcesEvent {
  type: 'host:resources';
  /** The harness process's CPU use since the last sample, as % of the
   *  whole machine (all cores). */
  cpuPct: number;
  /** The process's resident set, MB — on a model host this is effectively
   *  weights + KV + runtime. */
  rssMb: number;
  /** System-wide memory in use, MB — honest per-platform accounting
   *  (darwin: vm_stat active+wired+compressed; linux: total − MemAvailable).
   *  Absent where no honest read exists. */
  sysMemUsedMb?: number;
  /** Total machine memory, MB. */
  sysMemTotalMb?: number;
}

export interface EpiSample {
  at: number;
  h: number;
  s: number;
}

/** Model perplexity over the lane's produced tokens — exp(mean surprisal),
 *  the same accumulator the pool's branch tracker harvests. The one number
 *  comparable ACROSS agents; null before any sample. */
export function lanePpl(lane: AgentLane): number | null {
  return lane.nllCount === 0 ? null : Math.exp(lane.nllSum / lane.nllCount);
}

/** A harness intervention the model felt but the UI never showed until now:
 *  a guard rejecting a call before dispatch, a budget/pressure nudge, or an
 *  auth rejection on an ungranted protected tool. */
export interface Intervention {
  kind: 'guard' | 'nudge' | 'auth';
  agentId: number;
  at: number;
  tool?: string;
  args?: string;
  guard?: string;
  message?: string;
  reason?: string;
}

/** The admission funnel for one retrieval — `rerank:end`'s live mirror. */
export interface AdmissionSummary {
  selectedPassageCount: number;
  totalChars: number;
  durationMs: number;
  topResults: Array<{ file: string; heading: string; score: number; textPreview?: string }>;
  topK?: number;
  tokenBudget?: number;
  admittedTokens?: number;
  threshold?: number;
  totalScored?: number;
}

/** One tool call/result pair — the Sources tab's row. */
export interface Retrieval {
  agentId: number;
  tool: string;
  args: string;
  dispatchedAt: number;
  settledAt: number | null;
  /** The tool's JSON result string, when it settled. */
  result: string | null;
  contextAvailablePercent: number | null;
  /** From the `tool:dispatch` mirror — keys the trace metadata below. */
  callId: string | null;
  /** explore (agent-local scoring) vs exploit (re-ranked against the query).
   *  Null when the wire never said. */
  explore: boolean | null;
  /** The admission funnel (`rerank:end` mirror), when the tool ran one. */
  admission: AdmissionSummary | null;
  /** Exploit dual scores (`entailment:content:exploit` mirror) — the
   *  before/after ranking the slope chart draws. */
  exploitChunks: Array<{ heading: string; toolQueryScore: number; combinedScore: number }> | null;
  /** The call is PARKED: the tool reported a transient failure and the pool
   *  will re-execute after `afterMs` (`agent:tool_retry`). Rendered as
   *  waiting-on-the-outside-world, never as bare in-flight. */
  retry: { at: number; afterMs: number; attempt: number } | null;
}

/** One point of the live pressure series (`agent:tick` is the bus twin of the
 *  trace's per-commit `pool:tick`). */
export interface PressurePoint {
  at: number;
  cellsUsed: number;
  nCtx: number;
}

/** One INSTALLED ability (enabled or not), as `abilities:state` describes it: manifest-derived
 *  display fields, the config schema (field names/types for the Settings
 *  form), and stored config REDACTED to key-presence — values never ride
 *  the bus. */
export interface AbilityInfo {
  name: string;
  title?: string;
  description?: string;
  configSchema?: {
    properties?: Record<string, { type?: string; description?: string; 'x-secret'?: boolean }>;
    required?: string[];
  };
  config: Record<string, unknown>;
  enabled: boolean;
}

/** The folded pane state. Everything optional is honestly absent until its
 *  event arrives — the pane renders absence, never a placeholder value. */
/** The run's framing, declared by the HARNESS as data — the pane knows no
 *  pipeline's event names. `phases` maps a marker event to the label every
 *  agent spawned under it wears; `open` events reset the run (the timeline
 *  anchor); `close` events end it. A scaffold passes its own grammar beside
 *  the other DevPane wiring and EDITS it when a stage is added or renamed;
 *  the default covers the stock templates. */
export interface RunFraming {
  phases: Record<string, string>;
  /** The submission's start markers IN PIPELINE ORDER. Within one run they
   *  only advance (preflight → plan:start → query); a marker at or before
   *  the last one seen is a NEW submission superseding an unclosed run —
   *  the halt-and-resubmit path emits no close event. */
  open: readonly string[];
  close: readonly string[];
  /** Where the user's instruction lives on THIS harness's wire — the event
   *  type and the field carrying its text (and optionally the field carrying
   *  its media descriptors). Declared, never guessed: undeclared harnesses
   *  get a spine row folded from runtime events alone, with no instruction
   *  shown. */
  instruction?: { event: string; field: string; attachments?: string };
}

export const DEFAULT_FRAMING: RunFraming = {
  phases: {
    'preflight:start': 'recon',
    'plan:start': 'planner',
    'research:start': 'research',
    'synthesize:start': 'synth',
  },
  // Declared in WIRE order: preflight (when it runs) precedes the query
  // event, which the pipeline sends before the planner phase marker. An
  // out-of-order declaration makes the supersede heuristic fire a second
  // resetRun on every run (query idx > plan idx), wiping run-scoped state.
  open: ['preflight:start', 'query', 'plan:start'],
  close: ['complete', 'ui:error', 'ui:composer'],
  instruction: { event: 'query', field: 'query', attachments: 'attachments' },
};

/** One session-trunk turn (`branch:prefill role='warmDelta'` mirror) — the
 *  verbatim conversation delta the spine accreted, with what it cost. */
export interface TrunkTurn {
  at: number;
  /** Which conversation side — from the Session's own prefill call, never
   *  inferred from the text. `turn` is a committed whole exchange. */
  speaker?: 'user' | 'assistant' | 'tool' | 'turn';
  /** Verbatim prefilled text (the trunk conversation turn). */
  content: string;
  /** A committed exchange's halves (`speaker: 'turn'`) — never re-split
   *  from `content`. */
  query?: string;
  response?: string;
  /** KV cells the prefill added. */
  cells: number;
  /** The trunk branch this turn accreted onto — the key the release fold
   *  deletes by when that branch leaves the KV. */
  branchHandle?: number;
  /** The images that entered with it — roots, resolvable to bytes through
   *  the bridge's `representationUrl` when the harness exposes one. */
  attachments: { digest: string; mediaType?: string }[];
  /** Wall time of the run this delta settled out of — folded from the run
   *  anchor at arrival. Absent when no run was open. */
  wallMs?: number;
  /** What the run's agents spent (sum of its lanes' cumulative counters) to
   *  produce this delta — the numerator of the distillation ratio whose
   *  denominator is `cells`. Absent with `wallMs`. */
  agentTokens?: number;
}

export interface PaneModel {
  /** The current run's phase cursor — set by the framing's marker events;
   *  tags each spawn with a role. */
  runPhase: string | null;
  /** A run is OPEN from its first open-marker until a close-marker ends it —
   *  the reset guard, replacing the old 1.5s timing window (recon can hold
   *  the start markers apart for minutes). */
  runOpen: boolean;
  /** Position (in `framing.open`) of the last open-marker seen — the
   *  supersede detector: a marker at or before it starts a NEW run. */
  lastOpenIdx: number;
  /** When the current run began (`query` / `plan:start`) — the timeline's
   *  anchor. Null before the first run. */
  runStartAt: number | null;
  /** When the run delivered its `answer` — the run-complete marker. The
   *  phase gap between pools has no open lanes but the run is still LIVE:
   *  liveness is runStartAt-to-runEndedAt, not lane-counting. */
  runEndedAt: number | null;
  /** When a clarify continuation re-entered planning — guards the paired
   *  `plan:start` → `query` that follows from resetting the run. */
  runContinuedAt: number | null;
  /** Set while the run is HELD (`run:paused` → `run:resumed`). Lanes freeze
   *  at this instant — the gap to the advancing now-line IS the pause,
   *  drawn honestly (no decode happened there). */
  pausedAt: number | null;
  /** Set when wind-down begins (`run:windingDown`): agents are draining to
   *  their reports. Cleared on the next run. The transport cluster's cue to
   *  read "finishing" and refuse a second wrap-up or a pause. */
  windingDownAt: number | null;
  /** The dev gate — `config:loaded.dev`, the boot's LLOYAL_DEV signal carried
   *  on the wire. The FAB renders only when true. */
  dev: boolean;
  /** From basic's `ready.facts` — display only (research has no ready
   *  event; its status area degrades gracefully). */
  facts: {
    surface: string;
    model: { id: string; sizeBytes: number };
    abilities: string[];
  } | null;
  /** The live resolved config (`config:loaded` / `config:updated`, ability
   *  values already redacted by the harness). */
  config: Record<string, unknown> | null;
  /** Per-field provenance. */
  origin: Record<string, ConfigOriginValue> | null;
  /** Where the last save landed: a real path (edge) or null (served —
   *  "applied for this session"). Undefined until a save happens. */
  lastSavedTo: string | null | undefined;
  lanes: Map<number, AgentLane>;
  /** The RESIDENT conversation — the turns of the trunk the model can
   *  currently attend. Not cleared by `resetRun` (the next run rides the
   *  live trunk), but a released trunk's turns are REMOVED when its
   *  `branch:prune` folds: dead cells feed nothing, so the feed never
   *  shows them. History across trunks is the harness's concern. */
  trunk: TrunkTurn[];
  /** The run's SPINE, run-scoped: the shared root every agent forks from.
   *  Folded from runtime events alone (`branch:prefill role='spineHeader'`,
   *  `prompt:format role='spine'`) — universal to any pool harness — plus,
   *  when the harness DECLARES it ({@link RunFraming.instruction}), the
   *  user's instruction verbatim. This is the prompt's home in the pane
   *  even when a run later fails. Cleared by `resetRun`. */
  spine: {
    /** The user's instruction, as submitted — null until (unless) the
     *  harness's declared instruction event arrives. Never guessed. */
    query: string | null;
    attachments: { digest: string }[];
    /** First-seen moment (instruction arrival or first header prefill). */
    at: number;
    /** KV cells the spine header prefills added (outer + inner pools). */
    spineCells: number;
    /** The compiled spine header (system + tools), verbatim. */
    headerText: string | null;
    headerTokens: number;
    spineAt: number | null;
    /** Every moment the spine grew, with what it grew by — the seed first,
     *  then each extension (a chain step, a fanout widening). The bar's
     *  tick marks. */
    growth: { at: number; tokens: number }[];
    /** Positions inherited at fork — 0 on a cold start, the trunk's length
     *  on a warm one. From `branch:create role='spine'` position; first
     *  spine only (the inner pool's spine forks from the outer). */
    inherited?: number;
    /** Parsed from the STRUCTURED `tools` field the runtime emits on
     *  `prompt:format role='spine'` — reading data, not scraping markup. */
    tools?: { name: string; description: string }[];
    /** The system message text, from the structured `messages` field. */
    systemText?: string | null;
  } | null;
  retrievals: Retrieval[];
  pressure: PressurePoint[];
  /** Host samples (`host:resources`, dev-gated boots only): the harness
   *  process's cpu% of the whole machine, its resident set, and system
   *  memory (used/total MB, null where the platform offers no honest
   *  read) — the machine-pressure twin of the kv series. */
  host: { at: number; cpu: number; rssMb: number; memUsedMb: number | null; memTotalMb: number }[];
  /** Guard rejections, nudges, auth rejections — in arrival order. */
  interventions: Intervention[];
  /** Enabled abilities (`abilities:state`) — the Settings nav + form source.
   *  Null until the harness says; a harness that never emits it degrades to
   *  the redacted config keys. */
  abilities: AbilityInfo[] | null;
  /** The structured plan (`plan` with research intent) — task descriptions
   *  in fanout order, which is also flat-mode spawn order. */
  plan: { intent: string; tasks: string[] } | null;
  /** True between a clarify plan and the follow-up planning cycle — the
   *  next plan:start/query CONTINUES the run instead of resetting it. */
  clarifying: boolean;
  /** The first event's arrival time — the timeline's 0. */
  t0: number | null;
  eventCount: number;
}

export function createPaneModel(): PaneModel {
  return {
    runPhase: null,
    runOpen: false,
    lastOpenIdx: -1,
    runStartAt: null,
    runEndedAt: null,
    pausedAt: null,
    windingDownAt: null,
    runContinuedAt: null,
    dev: false,
    facts: null,
    config: null,
    origin: null,
    lastSavedTo: undefined,
    lanes: new Map(),
    trunk: [],
    spine: null,
    retrievals: [],
    pressure: [],
    host: [],
    interventions: [],
    abilities: null,
    plan: null,
    clarifying: false,
    t0: null,
    eventCount: 0,
  };
}

/** Cap kept generous: a full research run ticks a few thousand times; the
 *  strip renders a downsample anyway, and the pane must never grow without
 *  bound on a long-lived host. */
const MAX_PRESSURE_POINTS = 20_000;
const MAX_RETRIEVALS = 500;
const MAX_INTERVENTIONS = 200;
const MAX_TRUNK = 200;
const MAX_EPISTEMICS = 4096;
const MAX_HOST = 600;

/**
 * Fold one bus event into the model — MUTATING (the pane owns its model and
 * re-renders on a version counter; an immutable fold would copy a Map per
 * token). `now` is injected so the fold stays clock-free and testable.
 */
/** A new run begins: the timeline shows THE RUN, not wall-clock since page
 *  load — clear the run-scoped collections and anchor the axis. Idempotent
 *  (research emits `plan:start` then `query` back-to-back). */
/** A clarify answer re-enters planning WITHIN the same run: the planner
 *  asked, the user answered, the cycle continues — mark the exchange
 *  answered and keep everything. */
function continueRun(m: PaneModel, now: number): void {
  m.clarifying = false;
  m.runContinuedAt = now;
  for (const lane of m.lanes.values()) {
    if (lane.clarify && lane.clarify.answeredAt === null) lane.clarify.answeredAt = now;
  }
}

function resetRun(m: PaneModel, now: number): void {
  // Idempotent across a run's OWN start markers — recon opens the run
  // minutes before `plan:start`/`query` arrive, so this is a flag, not a
  // timing window. A close-marker (or supersede) re-arms it.
  if (m.runOpen) return;
  m.runOpen = true;
  m.lanes = new Map();
  m.retrievals = [];
  m.pressure = [];
  m.host = [];
  m.interventions = [];
  m.plan = null;
  m.spine = null;
  m.runStartAt = now;
  m.runEndedAt = null;
  m.pausedAt = null;
  m.windingDownAt = null;
}

/** The spine record, created by whichever signal arrives first — the
 *  harness's declared instruction event or the runtime's own header
 *  prefill. Runtime-only harnesses still get a spine row. */
function ensureSpine(m: PaneModel, now: number): NonNullable<PaneModel['spine']> {
  if (!m.spine) {
    m.spine = { query: null, attachments: [], at: now, spineCells: 0, headerText: null, headerTokens: 0, spineAt: null, growth: [] };
  }
  return m.spine;
}

/** The retrieval a mirrored trace event belongs to: by callId WITHIN the
 *  agent (callIds are per-agent counters — call_0 exists in every agent, so
 *  a global match attaches one agent's funnel to another's call), else the
 *  newest unsettled call of the agent. */
function findRetrieval(m: PaneModel, callId: string | null, agentId: number): Retrieval | undefined {
  if (callId) return m.retrievals.find((x) => x.callId === callId && x.agentId === agentId);
  for (let i = m.retrievals.length - 1; i >= 0; i--) {
    const r = m.retrievals[i];
    if (r.agentId === agentId && r.settledAt === null) return r;
  }
  return undefined;
}

export function foldEvent(
  m: PaneModel,
  ev: DevEvent,
  now: number,
  framing: RunFraming = DEFAULT_FRAMING,
): void {
  m.eventCount++;
  if (m.t0 === null) m.t0 = now;

  // ── run framing: the harness's OWN declared markers, as data ──
  if (framing.close.includes(ev.type)) {
    m.runOpen = false;
    m.lastOpenIdx = -1;
  }
  const openIdx = framing.open.indexOf(ev.type);
  if (openIdx !== -1) {
    if (m.clarifying) {
      // An answered clarify CONTINUES this run — never a reset.
      continueRun(m, now);
    } else {
      // Same submission's markers only ADVANCE through `open`; at-or-before
      // means a new submission superseded an unclosed run (halt-and-resubmit
      // emits no close marker).
      if (m.runOpen && openIdx <= m.lastOpenIdx) m.runOpen = false;
      resetRun(m, now);
    }
    m.lastOpenIdx = openIdx;
  }
  const phaseLabel = framing.phases[ev.type];
  if (phaseLabel !== undefined) m.runPhase = phaseLabel;

  // The user's instruction — read only where the harness DECLARED it lives
  // (framing.instruction), never guessed from event shapes. First one per
  // run wins: a re-plan re-emits the same event and must not reseed.
  const instr = framing.instruction;
  if (instr && ev.type === instr.event && (m.spine === null || m.spine.query === null)) {
    const s = ensureSpine(m, now);
    const q = (ev as Record<string, unknown>)[instr.field];
    if (typeof q === 'string') s.query = q;
    if (instr.attachments) {
      const a = (ev as Record<string, unknown>)[instr.attachments];
      if (Array.isArray(a)) {
        s.attachments = (a as unknown[]).flatMap((x) => {
          const r = x as { digest?: unknown };
          return typeof r.digest === 'string' ? [{ digest: r.digest }] : [];
        });
      }
    }
  }

  switch (ev.type) {
    case 'plan': {
      const intent = typeof ev.intent === 'string' ? ev.intent : 'research';
      if (intent === 'clarify') {
        // The planner asked the USER instead of planning — it now waits on
        // them, the same shape as an agent waiting on a tool. The run stays
        // open; the answer's planning cycle continues it (see resetRun).
        m.clarifying = true;
        const questions = Array.isArray(ev.clarifyQuestions)
          ? (ev.clarifyQuestions as unknown[]).filter((q): q is string => typeof q === 'string')
          : [];
        for (const lane of m.lanes.values()) {
          if (lane.role === 'planner') lane.clarify = { questions, askedAt: now, answeredAt: null };
        }
        return;
      }
      // The plan ARRIVED — the planner succeeded, whatever the pool's
      // recovery mechanics said afterwards (recovery_skipped fires for an
      // agent whose pool has nothing to salvage — the plan was already out).
      if (Array.isArray(ev.tasks)) {
        m.plan = {
          intent,
          tasks: (ev.tasks as unknown[]).map((t) =>
            typeof t === 'string' ? t
              : typeof (t as { description?: unknown })?.description === 'string'
                ? (t as { description: string }).description
                : ''),
        };
      }
      for (const lane of m.lanes.values()) {
        if (lane.role === 'planner') {
          lane.outcome = 'done';
          if (lane.doneAt === null) lane.doneAt = now;
        }
      }
      return;
    }
    case 'ready': {
      const facts = ev.facts as Record<string, unknown> | undefined;
      if (facts) {
        m.facts = {
          surface: typeof facts.surface === 'string' ? facts.surface : '',
          model: (facts.model as { id: string; sizeBytes: number }) ?? { id: '', sizeBytes: 0 },
          abilities: Array.isArray(facts.abilities) ? (facts.abilities as string[]) : [],
        };
      }
      return;
    }
    case 'abilities:state': {
      if (Array.isArray(ev.abilities)) {
        m.abilities = (ev.abilities as unknown[])
          .filter((a): a is AbilityInfo => !!a && typeof (a as AbilityInfo).name === 'string')
          .map((a) => ({ ...a, config: (a.config ?? {}) as Record<string, unknown> }));
      }
      return;
    }
    case 'config:loaded':
    case 'config:updated': {
      if (ev.type === 'config:loaded' && ev.dev === true) m.dev = true;
      if (ev.config && typeof ev.config === 'object') {
        m.config = ev.config as Record<string, unknown>;
      }
      if (ev.origin && typeof ev.origin === 'object') {
        m.origin = ev.origin as Record<string, ConfigOriginValue>;
      }
      if (ev.type === 'config:updated' && 'savedTo' in ev) {
        m.lastSavedTo = (ev.savedTo as string | null) ?? null;
      }
      return;
    }
    case 'agent:spawn': {
      const afterIds = Array.isArray(ev.after)
        ? (ev.after as unknown[]).filter((x): x is number => typeof x === 'number')
        : [];
      // Inherited-at-fork, snapshotted NOW: a recursive fork carries its
      // parent's attention state; a top-level fork carries trunk + the spine
      // as grown so far. Pre-spine forks get nothing — no guessed parentage.
      const parentLane = typeof ev.parentAgentId === 'number' ? m.lanes.get(ev.parentAgentId) : undefined;
      let inheritedAtFork: number | undefined;
      if (parentLane) {
        inheritedAtFork = (parentLane.inherited ?? 0) + parentLane.tokenCount;
      } else if (m.spine && m.spine.spineAt !== null && now + 250 >= m.spine.spineAt) {
        inheritedAtFork = (m.spine.inherited ?? 0)
          + m.spine.growth.reduce((n2, g) => (g.at <= now + 250 ? n2 + g.tokens : n2), 0);
      }
      if (typeof ev.agentId !== 'number') return; // type-only frame — never corrupt the lane map
      const id = ev.agentId as number;
      m.lanes.set(id, {
        agentId: id,
        parentAgentId: typeof ev.parentAgentId === 'number' ? ev.parentAgentId : null,
        role: m.runPhase,
        spawnedAt: now,
        doneAt: null,
        outcome: 'running',
        tokenCount: 0,
        ...(afterIds.length > 0 ? { after: afterIds } : {}),
        ...(inheritedAtFork !== undefined ? { inherited: inheritedAtFork } : {}),
        inflightTool: null,
        report: null,
        reportSource: null,
        prunedAt: null,
        dropReason: null,
        clarify: null,
        prompt: null,
        epistemics: [],
        nllSum: 0,
        nllCount: 0,
      });
      return;
    }
    case 'agent:produce': {
      const lane = m.lanes.get(ev.agentId as number);
      if (!lane) return;
      // tokenCount is CUMULATIVE on the wire — take the latest, never sum.
      if (typeof ev.tokenCount === 'number') lane.tokenCount = ev.tokenCount;
      if (typeof ev.entropy === 'number' && Number.isFinite(ev.entropy)
          && typeof ev.surprisal === 'number' && Number.isFinite(ev.surprisal)) {
        lane.epistemics.push({ at: now, h: ev.entropy, s: ev.surprisal });
        lane.nllSum += ev.surprisal;
        lane.nllCount += 1;
        if (lane.epistemics.length >= MAX_EPISTEMICS) {
          const e = lane.epistemics;
          const half: EpiSample[] = [];
          for (let i = 0; i + 1 < e.length; i += 2) {
            half.push({
              at: (e[i].at + e[i + 1].at) / 2,
              h: (e[i].h + e[i + 1].h) / 2,
              s: Math.max(e[i].s, e[i + 1].s),
            });
          }
          lane.epistemics = half;
        }
      }
      return;
    }
    case 'agent:done': {
      const lane = m.lanes.get(ev.agentId as number);
      if (lane) {
        lane.doneAt = now;
        if (lane.outcome === 'running') lane.outcome = 'done';
      }
      return;
    }
    case 'agent:return': {
      const lane = m.lanes.get(ev.agentId as number);
      if (lane && typeof ev.result === 'string') {
        lane.report = ev.result;
        lane.reportSource = 'voluntary';
      }
      return;
    }
    case 'agent:recovered': {
      const lane = m.lanes.get(ev.agentId as number);
      if (lane) {
        lane.outcome = 'recovered';
        if (typeof ev.result === 'string') {
          lane.report = ev.result;
          lane.reportSource = 'recovery';
        }
      }
      return;
    }
    case 'agent:failed': {
      const lane = m.lanes.get(ev.agentId as number);
      if (lane) {
        lane.failReason = typeof ev.reason === 'string' ? ev.reason : undefined;
        // A planner whose plan already arrived stays `done` — the raw reason
        // is kept for the detail pane, not painted as a run failure.
        if (!(lane.role === 'planner' && lane.outcome === 'done')) {
          lane.outcome = 'failed';
        }
        if (lane.doneAt === null) lane.doneAt = now;
      }
      return;
    }
    case 'agent:tool_call': {
      if (typeof ev.agentId !== 'number') return;
      const agentId = ev.agentId;
      const lane = m.lanes.get(agentId);
      const tool = typeof ev.tool === 'string' ? ev.tool : '';
      if (lane) lane.inflightTool = tool;
      m.retrievals.push({
        agentId,
        tool,
        args: typeof ev.args === 'string' ? ev.args : '',
        dispatchedAt: now,
        settledAt: null,
        result: null,
        contextAvailablePercent: null,
        callId: null,
        explore: null,
        admission: null,
        exploitChunks: null,
        retry: null,
      });
      if (m.retrievals.length > MAX_RETRIEVALS) m.retrievals.shift();
      return;
    }
    case 'agent:tool_result': {
      if (typeof ev.agentId !== 'number') return;
      const agentId = ev.agentId;
      const tool = typeof ev.tool === 'string' ? ev.tool : '';
      const lane = m.lanes.get(agentId);
      // Clear only the matching in-flight marker — a late result for an
      // earlier tool must not blank a newer call's state.
      if (lane && lane.inflightTool === tool) lane.inflightTool = null;
      // Settle the OLDEST unsettled call for this agent+tool — dispatch is
      // per-agent serial, so there is at most one.
      const r = m.retrievals.find(
        (x) => x.agentId === agentId && x.tool === tool && x.settledAt === null,
      );
      if (r) {
        r.settledAt = now;
        r.result = typeof ev.result === 'string' ? ev.result : null;
        r.contextAvailablePercent =
          typeof ev.contextAvailablePercent === 'number' ? ev.contextAvailablePercent : null;
      }
      return;
    }
    case 'agent:trace': {
      // The dev-gated tee: a trace event mirrored onto the bus, attributed.
      // Only the types the pane renders are folded; everything else is
      // ignored (the vocabulary can grow without breaking older panes).
      const agentId = typeof ev.agentId === 'number' ? ev.agentId : -1;
      const callId = typeof ev.callId === 'string' ? ev.callId : null;
      const te = ev.event as ({ type: string } & Record<string, unknown>) | undefined;
      if (!te) return;
      switch (te.type) {
        case 'branch:create': {
          // Cold vs warm, from the run's own record: the FIRST spine's fork
          // position. The inner pool's spine forks from the outer — skip it.
          if (te.role !== 'spine') return;
          {
            const s = ensureSpine(m, now);
            if (s.inherited === undefined && typeof te.position === 'number') s.inherited = te.position;
          }
          return;
        }

        case 'spine:extend': {
          // A settled contribution committed onto the spine mid-run (chain
          // steps). Later forks inherit it — the growth entry is what makes
          // their inherited-at-fork snapshot and the paid-once sum honest.
          const s = ensureSpine(m, now);
          const grew = typeof te.deltaTokens === 'number' ? te.deltaTokens : 0;
          s.spineCells += grew;
          if (grew > 0) s.growth.push({ at: now, tokens: grew });
          return;
        }

        case 'branch:prefill': {
          // The spine's seed — runtime truth, no harness assumption.
          if (te.role === 'spineHeader') {
            const s = ensureSpine(m, now);
            const grew = typeof te.cells === 'number' ? te.cells : 0;
            s.spineCells += grew;
            if (grew > 0) s.growth.push({ at: now, tokens: grew });
            if (s.spineAt === null) s.spineAt = now;
            return;
          }
          // The session trunk's own turns (role warmDelta) — visible beside
          // the runs they feed. Session-lived: resetRun leaves m.trunk alone.
          if (te.role !== 'warmDelta') return;
          const speaker = te.speaker;
          // Run-derived stats ride the response side: how long the run took
          // and what its agents spent to produce what the trunk kept.
          const responseSide = speaker === 'assistant' || speaker === 'turn' || speaker === undefined;
          const stats = responseSide && m.runStartAt !== null
            ? {
                wallMs: Math.max(0, now - m.runStartAt),
                agentTokens: [...m.lanes.values()].reduce((n, l) => n + l.tokenCount, 0),
              }
            : {};
          m.trunk.push({
            at: now,
            ...stats,
            ...(speaker === 'user' || speaker === 'assistant' || speaker === 'tool' || speaker === 'turn'
              ? { speaker } : {}),
            ...(typeof te.query === 'string' ? { query: te.query } : {}),
            ...(typeof te.response === 'string' ? { response: te.response } : {}),
            content: typeof te.content === 'string' ? te.content : '',
            cells: typeof te.cells === 'number' ? te.cells : 0,
            ...(typeof te.branchHandle === 'number' ? { branchHandle: te.branchHandle } : {}),
            attachments: Array.isArray(te.attachments)
              ? (te.attachments as unknown[]).flatMap((a) => {
                  const r = a as { digest?: unknown; mediaType?: unknown };
                  return typeof r.digest === 'string'
                    ? [{ digest: r.digest, ...(typeof r.mediaType === 'string' ? { mediaType: r.mediaType } : {}) }]
                    : [];
                })
              : [],
          });
          if (m.trunk.length > MAX_TRUNK) m.trunk.shift();
          return;
        }
        case 'pool:agentNudge': {
          m.interventions.push({
            kind: typeof te.guard === 'string' ? 'guard' : 'nudge',
            agentId, at: now,
            tool: typeof te.tool === 'string' ? te.tool : undefined,
            args: typeof te.args === 'string' ? te.args : undefined,
            guard: typeof te.guard === 'string' ? te.guard : undefined,
            message: typeof te.message === 'string' ? te.message : undefined,
            reason: typeof te.reason === 'string' ? te.reason : undefined,
          });
          if (m.interventions.length > MAX_INTERVENTIONS) m.interventions.shift();
          return;
        }
        case 'tool:authReject': {
          m.interventions.push({
            kind: 'auth', agentId, at: now,
            tool: typeof te.attemptedTool === 'string' ? te.attemptedTool : undefined,
          });
          if (m.interventions.length > MAX_INTERVENTIONS) m.interventions.shift();
          return;
        }
        case 'pool:agentDrop': {
          const lane = m.lanes.get(agentId);
          if (lane && typeof te.reason === 'string') lane.dropReason = te.reason;
          return;
        }
        case 'prompt:format': {
          // The compiled spine header — what position 0 actually holds.
          if (te.role === 'spine') {
            const s = ensureSpine(m, now);
            if (typeof te.promptText === 'string') s.headerText = te.promptText;
            if (typeof te.tokenCount === 'number') s.headerTokens = te.tokenCount;
            if (typeof te.tools === 'string') {
              try {
                const arr = JSON.parse(te.tools) as unknown[];
                if (Array.isArray(arr)) {
                  s.tools = arr.flatMap((x) => {
                    const f = (x as { function?: unknown }).function ?? x;
                    const g = f as { name?: unknown; description?: unknown };
                    return g && typeof g.name === 'string'
                      ? [{ name: g.name, description: typeof g.description === 'string' ? g.description : '' }]
                      : [];
                  });
                }
              } catch { /* not JSON — leave unparsed */ }
            }
            if (typeof te.messages === 'string') {
              try {
                const ms = JSON.parse(te.messages) as { role?: unknown; content?: unknown }[];
                if (Array.isArray(ms)) {
                  const sys = ms.find((mm) => mm && mm.role === 'system' && typeof mm.content === 'string');
                  s.systemText = sys ? (sys.content as string) : null;
                }
              } catch { /* not JSON */ }
            }
            return;
          }
          const lane = m.lanes.get(agentId);
          if (lane && typeof te.promptText === 'string') {
            lane.prompt = {
              text: te.promptText,
              tokenCount: typeof te.tokenCount === 'number' ? te.tokenCount : 0,
            };
          }
          return;
        }
        case 'branch:prune': {
          // agent ids ARE branch handles — the prune ends the hatched tail.
          const handle = typeof te.branchHandle === 'number' ? te.branchHandle : agentId;
          const lane = m.lanes.get(handle);
          if (lane) lane.prunedAt = now;
          // The same prune, seen by the trunk feed: this handle's turns
          // left the KV with it, so they leave the feed — the feed shows
          // the resident conversation, nothing else. Handle-matched (never
          // a blanket clear): an agent branch's prune must not touch the
          // trunk, and the match is order-independent with the next
          // generation's first commit.
          m.trunk = m.trunk.filter((t) => t.branchHandle !== handle);
          return;
        }
        case 'tool:dispatch': {
          // Keys the retrieval: newest unsettled call for this agent+tool
          // gains the callId + explore mode the trace metadata hangs off.
          const tool = typeof te.tool === 'string' ? te.tool : '';
          for (let i = m.retrievals.length - 1; i >= 0; i--) {
            const r = m.retrievals[i];
            if (r.agentId === agentId && r.tool === tool && r.settledAt === null && r.callId === null) {
              r.callId = typeof te.callId === 'string' ? te.callId : null;
              r.explore = typeof te.explore === 'boolean' ? te.explore : null;
              break;
            }
          }
          return;
        }
        case 'rerank:end': {
          const r = findRetrieval(m, callId, agentId);
          if (r) {
            r.admission = {
              selectedPassageCount: typeof te.selectedPassageCount === 'number' ? te.selectedPassageCount : 0,
              totalChars: typeof te.totalChars === 'number' ? te.totalChars : 0,
              durationMs: typeof te.durationMs === 'number' ? te.durationMs : 0,
              topResults: Array.isArray(te.topResults) ? (te.topResults as AdmissionSummary['topResults']) : [],
              ...(typeof te.topK === 'number' ? { topK: te.topK } : {}),
              ...(typeof te.tokenBudget === 'number' ? { tokenBudget: te.tokenBudget } : {}),
              ...(typeof te.admittedTokens === 'number' ? { admittedTokens: te.admittedTokens } : {}),
              ...(typeof te.threshold === 'number' ? { threshold: te.threshold } : {}),
              ...(typeof te.totalScored === 'number' ? { totalScored: te.totalScored } : {}),
            };
          }
          return;
        }
        case 'entailment:content:exploit': {
          const r = findRetrieval(m, callId, agentId);
          if (r && Array.isArray(te.chunks)) {
            r.exploitChunks = te.chunks as Retrieval['exploitChunks'];
          }
          return;
        }
        default:
          return;
      }
    }
    case 'agent:tool_retry': {
      const agentId = ev.agentId as number;
      const tool = typeof ev.tool === 'string' ? ev.tool : '';
      for (let i = m.retrievals.length - 1; i >= 0; i--) {
        const r = m.retrievals[i];
        if (r.agentId === agentId && r.tool === tool && r.settledAt === null) {
          r.retry = {
            at: now,
            afterMs: typeof ev.retryAfterMs === 'number' ? ev.retryAfterMs : 0,
            attempt: typeof ev.attempt === 'number' ? ev.attempt : 1,
          };
          break;
        }
      }
      return;
    }
    case 'agent:tick': {
      if (typeof ev.cellsUsed === 'number' && typeof ev.nCtx === 'number') {
        m.pressure.push({ at: now, cellsUsed: ev.cellsUsed, nCtx: ev.nCtx });
        if (m.pressure.length > MAX_PRESSURE_POINTS) m.pressure.shift();
      }
      return;
    }
    case 'run:paused': {
      m.pausedAt = now;
      return;
    }
    case 'run:resumed': {
      m.pausedAt = null;
      return;
    }
    case 'run:windingDown': {
      m.windingDownAt = now;
      return;
    }
    case 'answer': {
      if (m.runStartAt !== null) m.runEndedAt = now;
      return;
    }
    case 'host:resources': {
      if (typeof ev.cpuPct !== 'number' || typeof ev.rssMb !== 'number') return;
      m.host.push({
        at: now, cpu: ev.cpuPct, rssMb: ev.rssMb,
        memUsedMb: typeof ev.sysMemUsedMb === 'number' ? ev.sysMemUsedMb : null,
        memTotalMb: typeof ev.sysMemTotalMb === 'number' ? ev.sysMemTotalMb : 0,
      });
      if (m.host.length > MAX_HOST) m.host.shift();
      return;
    }
    default:
      return;
  }
}

/** Live when any lane is still open — the run is producing and the pane's
 *  clocks (elapsed, park countdowns) must keep advancing even between
 *  events. */
export function isLive(m: PaneModel): boolean {
  if (m.runStartAt !== null && m.runEndedAt === null) return true;
  for (const l of m.lanes.values()) if (l.doneAt === null) return true;
  return false;
}

/** The latest pressure reading as a 0–100 used percentage, or null before the
 *  first tick. */
export function pressurePercent(m: PaneModel): number | null {
  const last = m.pressure[m.pressure.length - 1];
  if (!last || last.nCtx <= 0) return null;
  return Math.round((last.cellsUsed / last.nCtx) * 100);
}

/** Downsample the pressure series to at most `buckets` points for a strip
 *  chart — plotted against TIME (the tick rate slows as the context fills, so
 *  index-based plotting would stretch exactly the interesting part). */
export function pressureStrip(
  m: PaneModel,
  buckets: number,
): { at: number; pct: number }[] {
  if (m.pressure.length === 0 || buckets <= 0) return [];
  const first = m.pressure[0].at;
  const last = m.pressure[m.pressure.length - 1].at;
  const span = Math.max(1, last - first);
  const out: { at: number; pct: number }[] = [];
  let bi = -1;
  for (const p of m.pressure) {
    const b = Math.min(buckets - 1, Math.floor(((p.at - first) / span) * buckets));
    const pct = p.nCtx > 0 ? (p.cellsUsed / p.nCtx) * 100 : 0;
    if (b !== bi) {
      out.push({ at: p.at, pct });
      bi = b;
    } else {
      out[out.length - 1] = { at: p.at, pct };
    }
  }
  return out;
}

const SPARK = '▁▂▃▄▅▆▇█';


/** A fixed-width unicode sparkline of the pressure series — pure, node-free
 *  (the ink overlay renders it; anything else may too). */
export function sparkline(m: PaneModel, width: number): string {
  const strip = pressureStrip(m, width);
  if (strip.length === 0) return '';
  return strip.map((p) => SPARK[Math.min(7, Math.floor((p.pct / 100) * 8))]).join('');
}

/** Display order + one-clause meaning for each provenance rung — the six real
 *  values, nothing invented. */
export const PROVENANCE_RUNGS: readonly { rung: ConfigOriginValue; means: string }[] = [
  { rung: 'cli', means: 'a command-line flag' },
  { rung: 'env', means: 'an environment variable' },
  { rung: 'file', means: 'harness.json — your local overrides' },
  { rung: 'yml', means: 'harness.yml — the committed manifest' },
  { rung: 'session', means: 'this session only — no file remembers it' },
  { rung: 'default', means: 'nothing set it' },
];

/** The tier each well-known config key answers to. The runtime sets the tier,
 *  not the UI — it decides whether a control can exist at all. */
export type ConfigTier = 'session' | 'reload' | 'boot';
export const KEY_TIERS: Readonly<Record<string, ConfigTier>> = {
  'sources.outputDir': 'session',
  'defaults.effort': 'session',
  'defaults.reasoningMode': 'session',
  'model.path': 'reload',
  'model.reranker': 'reload',
  'model.gpu': 'reload',
  'model.imageMinTokens': 'reload',
  'model.imageMaxTokens': 'reload',
  'model.nCtx': 'boot',
  'model.branches': 'boot',
  'model.kvCache': 'boot',
};

/** Read a dotted config path off the live config object. */
export function readConfigPath(
  config: Record<string, unknown> | null,
  path: string,
): unknown {
  if (!config) return undefined;
  let node: unknown = config;
  for (const seg of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}
