import type { ParsedToolCall, MultimodalDelta } from '@lloyal-labs/sdk';
// `ToolRetryError` is no longer named here: a completion carries how the call
// ended; recognising a transient failure is the frame's (`hooks.ts`).
import type { Attachment } from '@lloyal-labs/media';
import type { Branch } from '@lloyal-labs/sdk';
import type { Agent, ToolHistoryEntry, FormatConfig } from './Agent';
import type { ContextPressure } from './pressure';
import type { RecoveryAction } from './AgentPolicy';
import type { Outcome, Completion } from './Tool';
import type { AgentTaskSpec, AgentExitReason } from './types';
import type { ReplayStep, AgentTurnRecord } from './replay';
import type { TraceEvent } from './trace-types';

/**
 * The pool's vocabulary as VALUES — what the scheduler reads, what it
 * returns, and what the loop carries between ticks. Nothing in this file
 * touches the store or the wire.
 *
 * The idiom is the continuous-batching scheduler: per tick a pure
 * `schedule(state)` returns a {@link Schedule}; `execute` runs it against the
 * store; `apply` interprets what came back. The agent's own record lives on
 * {@link Agent}; these are the records that exist BETWEEN agents.
 */

/** A `pool:agentDrop` reason — the wire union is the vocabulary. */
export type DropReason = Extract<TraceEvent, { type: 'pool:agentDrop' }>['reason'];

// ── Pending work ────────────────────────────────────────────────

/**
 * Something waiting to enter an agent's cache: a tool result, a nudge
 * standing in for one, or a recovery turn. Every item knows its cost in
 * CELLS — media included, which is why the cost was measured upstream and
 * is never re-derived here.
 */
export type PrefillItem = {
  /** What the item places: the call's result, a nudge in its place, or a
   *  recovery prompt — the same word the agent's ledger books. */
  kind: Outcome;
  agent: Agent;
  toolName: string;
  callId: string;
  args: string;
  /** What the agent receives: the tool's value, a nudge's `{ error }`, the
   *  pool's own failure text. What `afterAdmit` is shown once the item is
   *  booked. Absent only for a recovery prompt. */
  result?: unknown;
  /** The tool-result string the delta was built from — the heal record's
   *  replay material. Absent for nudges and recovery turns. */
  resultStr?: string;
} & (
  /** The token rail: the delta tokenized here and prefilled as tokens. */
  | { rail: 'token'; tokens: number[]; media?: never;
      /** Roots admitted with a token-rail result — ones that materialize to
       *  no bitmaps — booked as assets available to the run. */
      attachments?: readonly Attachment[] }
  /** The embedding rail. `llama_batch` is token-XOR-embd, so this cannot
   *  join a token batch — a separate call, not a separate strategy. */
  | { rail: 'media'; tokens?: never; media: { delta: MultimodalDelta; cells: number; attachments: readonly Attachment[] } }
);

/** What admission spends on this item — the ONE place that answers it. */
export function itemCells(item: PrefillItem): number {
  return item.rail === 'media' ? item.media.cells : item.tokens.length;
}

/** A transient tool failure parked until `notBefore` (wall clock). */
export interface RetryPark {
  agent: Agent; tc: ParsedToolCall; callId: string; notBefore: number; attempt: number;
}

/** A tool call the model made; dispatched next tick. */
export interface DispatchRequest {
  agent: Agent; tc: ParsedToolCall; retryAttempt?: number; retryCallId?: string;
}

/** An orchestrator's `spawn`, priced and waiting: its suffix is tokenized and
 *  its format fixed, but no branch exists yet. The scheduler admits it when the
 *  KV fits, a sequence is free and the pool has a seat; the executor forks it
 *  then, prefills the suffix and activates it. The orchestrator suspends on
 *  `resolve`/`reject` until then. `index` is its place in the pool's ledger of
 *  spawns, where its outcome is kept. */
export interface SpawnRequest {
  index: number; key?: string; task: AgentTaskSpec;
  suffixTokens: number[]; formattedPrompt: string; fmt: FormatConfig;
  /** The branch to fork: the spec's parent, else the spine. */
  parent: Branch;
  /** The agent whose tool call made the request, read where the request was made; null off the loop. */
  caller: Agent | null;
  resolve: (agent: Agent) => void; reject: (err: Error) => void; discarded: boolean;
  /** A heal is a spawn wearing a lineage: the original's record, replayed onto
   *  the fork once its suffix has been prefilled. Nobody awaits it (`resolve`/`reject`
   *  are no-ops); the ledger entry it belongs to is the original's. */
  replay?: SpawnReplay;
}
export interface SpawnReplay {
  /** The lineage, built once and priced — what the replacement will prefill after its suffix. */
  steps: ReplayStep[]; cells: number;
  of: number; rc?: number; attempt: number;
  /** The original's attended tool history — re-booked onto the replacement so its
   *  receipt ledger matches the KV the steps replay. The replay restores content,
   *  not history; without this a healed read tool re-delivers what its branch holds. */
  history: readonly ToolHistoryEntry[];
  /** The parent's position at the original's fork — the replacement forks there or the heal stands down. */
  forkHead: number;
}

/** Why a spawn was not seated. */
export type SpawnRefusal = 'pressure_init' | 'no_sequence';
/** A spawn the scheduler refused, or one whose fork failed at admission. */
export interface RefusedSpawn { req: SpawnRequest; reason: SpawnRefusal; detail?: string }

/** What a heal hands to the pool to forge its replacement from. */
export interface Lineage {
  records: readonly AgentTurnRecord[];
  /** The parent's position at the original's fork — the replacement forks the
   *  same parent (the spec's, or the spine) at exactly this position, or the
   *  heal stands down: the records carry only what came after the fork. */
  forkHead: number;
  /** The original's attended tool history — carried onto the replacement (see {@link SpawnReplay.history}). */
  history: readonly ToolHistoryEntry[];
  of: number; rc?: number; attempt: number;
}

/** What admission spends on a spawn — the suffix, and the lineage a heal
 *  replays. The ONE place that answers it, like {@link itemCells}. */
export function spawnCells(req: SpawnRequest): number {
  return req.suffixTokens.length + (req.replay?.cells ?? 0);
}

/** An orchestrator's `extendSpine`, prefilled onto the spine with the spawns. */
export interface ExtendRequest {
  tokens: number[]; userContent: string; assistantContent: string;
  resolve: (deltaTokens: number) => void; reject: (err: Error) => void; discarded: boolean;
}


/** Everything that is waiting, by kind. ONE record the loop owns; the
 *  scheduler reads it and returns what remains after this tick's admissions. */
export interface Pending {
  items: PrefillItem[];
  retries: RetryPark[];
  dispatches: DispatchRequest[];
  spawns: SpawnRequest[];
  extends: ExtendRequest[];
}

export function emptyPending(): Pending {
  return { items: [], retries: [], dispatches: [], spawns: [], extends: [] };
}

// ── The tick's inputs and outputs ───────────────────────────────

/** Everything `schedule()` may read. Built once per tick. */
export interface TickState {
  tick: number;
  /** The run clock — wall time minus paused spans (policy budgets). */
  now: number;
  /** The wall clock, sampled with the pressure: what retry parks are due against. */
  wall: number;
  /** ONE sample, taken after the previous tick's effects were applied. */
  pressure: ContextPressure;
  agents: readonly Agent[];
  pending: Pending;
  signals: {
    paused: boolean;
    windDown: boolean;
    /** User cancels queued since the last tick. */
    cancelled: readonly number[];
    orchestratorDone: boolean;
  };
  /** Agents with a fan-out tool child still running. */
  inflight: ReadonlySet<number>;
  /** Vacant sequences in the store, sampled with the pressure: what a fork needs one of. */
  sequences: number;
}

/**
 * How a dropped agent gets its findings out, decided with the drop:
 * - `salvage`: it was mid-terminal-call; parse what it already emitted.
 * - `extract`: prefill the recovery prompt; the report decodes in-loop under
 *   `budget` (Infinity = serial, uncapped).
 * - `skip`: the policy declined; the agent fails cleanly.
 * - `none`: nothing to recover (a cancel).
 */
export type Recovery =
  | { type: 'salvage' }
  | { type: 'extract'; action: Extract<RecoveryAction, { type: 'extract' }>; budget: number; serial: boolean }
  | { type: 'skip' }
  | { type: 'none' };

/** A decision to stop an agent, with everything the enactment needs. */
export interface Drop {
  agent: Agent;
  /** `null` = the agent stopped on its own terms (free text, no call): the
   *  span still ends, but no `pool:agentDrop` record is written. */
  reason: DropReason | null;
  /** Whether this drop ends the agent's span (`agent:done`). Cancels and a
   *  re-drop of an already-extracting agent do not. */
  done: boolean;
  exitReason?: AgentExitReason;
  recovery: Recovery;
}

/** One deferred item's fate at the stall-break, in the order it is announced:
 *  the policy's nudge (recorded whether or not it fit), then the drop the item
 *  fell into when it did not. */
export interface StallOutcome {
  agent: Agent;
  nudge: { message: string; tool: string; args: string; replacement: PrefillItem | null } | null;
  drop: Drop | null;
}

/**
 * What runs this tick — the scheduler's output. The phases are FIELDS;
 * `execute` runs them in one fixed order.
 */
export interface Schedule {
  /** Paused: only cancels' halts run; nothing decodes. */
  hold: boolean;
  /** Agents whose in-flight fan-out tool is halted (cancels). */
  halts: Agent[];
  /** Schedule-time drops, in decision order. */
  drops: Drop[];
  /** Extracting agents whose report hit its token-stop: finish without sampling. */
  finishes: Agent[];
  /** Spawns admitted this tick: the executor forks, prefills and activates them. */
  spawns: SpawnRequest[];
  /** Spawns that can never be seated: nothing alive or prunable is left to free what they need. */
  refusedSpawns: RefusedSpawn[];
  /** Extends admitted against headroom; they land as ONE pair on the spine. */
  extends: ExtendRequest[];
  /** Extends that can never fit: nothing alive or prunable is left to free KV. */
  rejectedExtends: ExtendRequest[];
  /** Admitted items, in admission order. */
  prefills: PrefillItem[];
  /** Stall-break outcomes for items that could not be admitted, in item order. */
  stall: StallOutcome[];
  /** Wind-down: parked retries settled as an honest failure instead of waited out. */
  abandoned: RetryPark[];
  dispatch: DispatchRequest[];
  /** Agents that sample this tick: active now and not dropped. Agents the
   *  execute step itself re-activates (admitted items, spawns) join
   *  the decode set as they land. */
  decode: Agent[];
  /** The post-admission pressure — what produce-phase and dispatch decisions read. */
  pressure: ContextPressure;
  /** Agents that could still need recovery this tick (`active`|`awaiting`
   *  plus this tick's spawns) — the divisor of the cohort report budget. */
  alive: number;
  /** What is still waiting after this tick's admissions. */
  remaining: Pending;
  /** The recovery mode this tick decided under (wind-down forces `cohort`). */
  mode: 'serial' | 'cohort';
  /** The roster the decisions were made over. */
  roster: readonly Agent[];
  /** Nothing left to do: the pool closes after this tick. */
  close: boolean;
}

/** A tool's completion, carried from wherever it ran to the intake: how the
 *  call completed, and which attempt this was (1 for the first execution, one
 *  more per retry — `DispatchRequest.retryAttempt` counts the retries before
 *  it, so the two are offset by one). What it means — an attempt, a park, a
 *  failure — is the frame's to decide at intake, not the runner's. */
export interface ToolCompletion {
  agent: Agent; tc: ParsedToolCall; callId: string; dispatchTraceId: number; toolT0: number;
  attempt: number;
  completion: Completion;
}

/** One admitted prefill's fate, as the store reported it. */
export type PrefillOutcome =
  | { ok: true }
  | { ok: false; rc?: number; partial?: boolean; message: string };

/** What the store gave back for one tick. */
export interface Outputs {
  /** The token-rail cohort's outcome (one prefill call, one outcome). */
  tokenRail: { items: PrefillItem[]; outcome: PrefillOutcome } | null;
  /** The media rail's per-entry outcomes. */
  mediaRail: { item: PrefillItem; outcome: PrefillOutcome }[];
  /** What each sampled agent produced; only the stops need interpreting.
   *  `parsed` is the strict parse taken at the sample (null for an extracting
   *  agent, whose report is parsed by the recovery path). */
  produced: { agent: Agent; token: number; text: string; isStop: boolean; parsed: import('@lloyal-labs/sdk').ParseChatOutputResult | null }[];
  /** Admitted spawns whose fork failed at admission — the store said a sequence was
   *  vacant and the fork found none. Refused like a scheduler refusal. */
  spawnRefused: RefusedSpawn[];
  /** The commit succeeded (`steps` counts these), with the reading taken as it did. */
  committed: boolean;
  commitPressure: ContextPressure | null;
  /** A decode failed beyond the ladder: a fatal prefill rc, or the commit
   *  (KV exhausted). The pool closes partial. */
  fatal: { phase: 'prefill' | 'commit'; err: unknown } | null;
}

// ── Terminal helpers ────────────────────────────────────────────

/** An agent whose branch still holds cells nothing will read again. */
export function prunable(a: Agent): boolean {
  return a.pruneRequested && !a.branch.disposed;
}

/**
 * The branches pending spawns still need. A request carries a priced suffix and NO branch — that is
 * what lets admission weigh it before any lease is taken — so nothing else records that a parent is
 * still owed to someone. Derived where it is read, so admission (the request leaves the queue),
 * withdrawal (`discarded`) and refusal (it leaves too) each release it with no second bookkeeping
 * path to keep in step.
 */
export function owedParents(spawns: readonly SpawnRequest[]): Set<number> {
  const owed = new Set<number>();
  for (const req of spawns) if (!req.discarded) owed.add(req.parent.handle);
  return owed;
}

/**
 * Whether the next prune pass will actually take this agent: a childless leaf owed a prune that no
 * pending spawn retains.
 *
 * ONE definition, because the executor's retention and the scheduler's idea of reclamation-to-come
 * have to be the same sentence. When they drifted apart, a scheduler counting a retained parent as
 * progress waited for a prune the executor would refuse — and the spawn it was waiting for was the
 * one holding the pin, so a queued child was neither seated nor refused.
 */
export function reclaimable(a: Agent, owed: ReadonlySet<number>): boolean {
  return prunable(a) && a.branch.children.length === 0 && !owed.has(a.branch.handle);
}

export function alive(a: Agent): boolean {
  return a.status === 'active' || a.status === 'awaiting_tool';
}

/**
 * The self-healing ladder's one classification (docs/self-healing.md):
 * rc 1 restored the failing call and nothing before it was prefilled → the
 * branch is INTACT and the item may re-queue; rc 1 with an earlier chunk
 * prefilled → the cohort cannot be re-queued whole (it would decode those chunks
 * twice) → fail; rc 2 / < −1 / no rc / tripwire up → fatal.
 */
export function classifyRc(rc: number | undefined, partial: boolean | undefined, backendSuspect: boolean): 'defer' | 'fail' | 'fatal' {
  if (backendSuspect || rc !== 1) return 'fatal';
  return partial ? 'fail' : 'defer';
}

/** A fatal rc as the ladder counts it: 2, or below −1. */
export function isFatalRc(rc: number | undefined): boolean {
  return rc === 2 || (rc !== undefined && rc < -1);
}

/** Self-healing ladder state shared by the interpreter and the executor. */
export interface Ladder { consecutiveFatalRc: number; backendSuspect: boolean }
export const MAX_DEFER_ATTEMPTS = 3;
export const BACKEND_TRIPWIRE_N = 3;
export const MAX_HEAL_ATTEMPTS = 1;
/** Returns that may be rejected for one agent — by the terminal tool, a harness floor, anyone at `onReturn` — before the next is accepted as it stands. */
export const MAX_RETURNS_REJECTED = 1;
