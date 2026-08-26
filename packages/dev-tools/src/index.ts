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
  /** One clause shown beside the control, e.g. `applies next run`. */
  note?: string;
  /** Read the current value out of the live config object. */
  read: (config: Record<string, unknown>) => string | undefined;
}

/** One lane row of the timeline: an agent's span, derived live from the bus. */
export interface AgentLane {
  agentId: number;
  parentAgentId: number | null;
  spawnedAt: number;
  doneAt: number | null;
  /** Terminal outcome, when known. `failed` carries the reason. */
  outcome: 'running' | 'done' | 'recovered' | 'failed';
  failReason?: string;
  tokenCount: number;
  /** tool name → the call currently in flight (cleared on result). */
  inflightTool: string | null;
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
}

/** One point of the live pressure series (`agent:tick` is the bus twin of the
 *  trace's per-commit `pool:tick`). */
export interface PressurePoint {
  at: number;
  cellsUsed: number;
  nCtx: number;
}

/** The folded pane state. Everything optional is honestly absent until its
 *  event arrives — the pane renders absence, never a placeholder value. */
export interface PaneModel {
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
  retrievals: Retrieval[];
  pressure: PressurePoint[];
  /** The first event's arrival time — the timeline's 0. */
  t0: number | null;
  eventCount: number;
}

export function createPaneModel(): PaneModel {
  return {
    dev: false,
    facts: null,
    config: null,
    origin: null,
    lastSavedTo: undefined,
    lanes: new Map(),
    retrievals: [],
    pressure: [],
    t0: null,
    eventCount: 0,
  };
}

/** Cap kept generous: a full research run ticks a few thousand times; the
 *  strip renders a downsample anyway, and the pane must never grow without
 *  bound on a long-lived host. */
const MAX_PRESSURE_POINTS = 20_000;
const MAX_RETRIEVALS = 500;

/**
 * Fold one bus event into the model — MUTATING (the pane owns its model and
 * re-renders on a version counter; an immutable fold would copy a Map per
 * token). `now` is injected so the fold stays clock-free and testable.
 */
export function foldEvent(m: PaneModel, ev: DevEvent, now: number): void {
  m.eventCount++;
  if (m.t0 === null) m.t0 = now;

  switch (ev.type) {
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
      const id = ev.agentId as number;
      m.lanes.set(id, {
        agentId: id,
        parentAgentId: typeof ev.parentAgentId === 'number' ? ev.parentAgentId : null,
        spawnedAt: now,
        doneAt: null,
        outcome: 'running',
        tokenCount: 0,
        inflightTool: null,
      });
      return;
    }
    case 'agent:produce': {
      const lane = m.lanes.get(ev.agentId as number);
      // tokenCount is CUMULATIVE on the wire — take the latest, never sum.
      if (lane && typeof ev.tokenCount === 'number') lane.tokenCount = ev.tokenCount;
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
    case 'agent:recovered': {
      const lane = m.lanes.get(ev.agentId as number);
      if (lane) lane.outcome = 'recovered';
      return;
    }
    case 'agent:failed': {
      const lane = m.lanes.get(ev.agentId as number);
      if (lane) {
        lane.outcome = 'failed';
        lane.failReason = typeof ev.reason === 'string' ? ev.reason : undefined;
        if (lane.doneAt === null) lane.doneAt = now;
      }
      return;
    }
    case 'agent:tool_call': {
      const agentId = ev.agentId as number;
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
      });
      if (m.retrievals.length > MAX_RETRIEVALS) m.retrievals.shift();
      return;
    }
    case 'agent:tool_result': {
      const agentId = ev.agentId as number;
      const lane = m.lanes.get(agentId);
      if (lane) lane.inflightTool = null;
      // Settle the OLDEST unsettled call for this agent+tool — dispatch is
      // per-agent serial, so there is at most one.
      const r = m.retrievals.find(
        (x) => x.agentId === agentId && x.tool === ev.tool && x.settledAt === null,
      );
      if (r) {
        r.settledAt = now;
        r.result = typeof ev.result === 'string' ? ev.result : null;
        r.contextAvailablePercent =
          typeof ev.contextAvailablePercent === 'number' ? ev.contextAvailablePercent : null;
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
    default:
      return;
  }
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
  if (m.pressure.length === 0) return [];
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
