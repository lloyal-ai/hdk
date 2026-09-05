import type { ParsedToolCall, MultimodalDelta } from '@lloyal-labs/sdk';
import type { Attachment } from '@lloyal-labs/media';
import type { Agent } from './Agent';
import type { ContextPressure } from './pressure';
import type { RecoveryAction } from './AgentPolicy';
import type { AgentTaskSpec, AgentExitReason } from './types';
import type { AgentTurnRecord } from './replay';
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
  kind: 'toolResult' | 'nudge' | 'recovery';
  agent: Agent;
  toolName: string;
  callId: string;
  args: string;
  probe?: string;
  /** The tool-result string the delta was built from — the heal record's
   *  replay material. Absent for nudges and recovery turns. */
  resultStr?: string;
} & (
  /** The token rail: the delta tokenized here and prefilled as tokens. */
  | { rail: 'token'; tokens: number[]; media?: never }
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

/** An orchestrator's `spawn`: the agent is forked and its suffix tokenized;
 *  the suffix prefill and the activation are scheduler work. The
 *  orchestrator suspends on `resolve`/`reject` until then. */
export interface SpawnRequest {
  agent: Agent; suffixTokens: number[]; formattedPrompt: string; task: AgentTaskSpec;
  resolve: (agent: Agent) => void; reject: (err: Error) => void; discarded: boolean;
}

/** An orchestrator's `extendSpine`, prefilled onto the spine with the spawns. */
export interface ExtendRequest {
  tokens: number[]; userContent: string; assistantContent: string;
  resolve: (deltaTokens: number) => void; reject: (err: Error) => void; discarded: boolean;
}

/** A poisoned agent's warm respawn: a fresh fork of the spine that replays
 *  the original's record (docs/self-healing.md). */
export interface HealRequest {
  spec: AgentTaskSpec; records: AgentTurnRecord[]; of: number; rc?: number; attempt: number;
}

/** Everything that is waiting, by kind. ONE record the loop owns; the
 *  scheduler reads it and returns what remains after this tick's admissions. */
export interface Pending {
  items: PrefillItem[];
  retries: RetryPark[];
  dispatches: DispatchRequest[];
  spawns: SpawnRequest[];
  extends: ExtendRequest[];
  heals: HealRequest[];
}

export function emptyPending(): Pending {
  return { items: [], retries: [], dispatches: [], spawns: [], extends: [], heals: [] };
}

// ── The tick's inputs and outputs ───────────────────────────────

/** Everything `schedule()` may read. Built once per tick. */
export interface TickState {
  tick: number;
  /** The run clock — wall time minus paused spans. */
  now: number;
  /** ONE sample, taken after the previous tick's effects landed. */
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
  spawns: SpawnRequest[];
  rejectedSpawns: SpawnRequest[];
  extends: ExtendRequest[];
  heals: HealRequest[];
  /** Admitted items, in admission order. */
  prefills: PrefillItem[];
  /** Stall-break outcomes for items that could not be admitted, in item order. */
  stall: StallOutcome[];
  /** Wind-down: parked retries settled as an honest failure instead of waited out. */
  abandoned: RetryPark[];
  /** The close-time sweep: one idle-without-result agent recovers serially, with no drop record. */
  sweep: { agent: Agent; recovery: Recovery } | null;
  dispatch: DispatchRequest[];
  /** Agents that sample this tick: active now and not dropped. Agents the
   *  execute step itself re-activates (admitted items, spawns, heals) join
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

/** A tool's completion, carried from wherever it ran to the intake. */
export type ToolCompletion =
  | { kind: 'result'; agent: Agent; tc: ParsedToolCall; callId: string; dispatchTraceId: number; toolT0: number; result: unknown }
  | { kind: 'retry'; agent: Agent; tc: ParsedToolCall; callId: string; dispatchTraceId: number; toolT0: number; retryAttempt: number; err: import('./Tool').ToolRetryError }
  | { kind: 'error'; agent: Agent; tc: ParsedToolCall; callId: string; dispatchTraceId: number; err: Error };

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
  /** The commit landed (`steps` counts these), with the reading taken as it did. */
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

export function alive(a: Agent): boolean {
  return a.status === 'active' || a.status === 'awaiting_tool';
}

/**
 * The self-healing ladder's one classification (docs/self-healing.md):
 * rc 1 restored the failing call and nothing before it landed → the branch
 * is INTACT and the item may re-queue; rc 1 with an earlier chunk landed
 * → the cohort cannot be re-queued whole (it would decode landed chunks
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
