import type { Branch, SessionContext, ParseChatOutputResult } from '@lloyal-labs/sdk';
import type { GrammarTrigger } from '@lloyal-labs/sdk';
import { createSignal, type Signal } from 'effection';
import type { TraceToken, AgentExitReason, AgentTaskSpec } from './types';
import type { AgentTurnRecord } from './replay';
import type { Lineage } from './state';

// ── Status ──────────────────────────────────────────────────

/**
 * Agent status — domain language for where the agent is in its lifecycle.
 *
 * - `idle`: created but not yet generating, OR finished but branch still
 *    alive (extraction window for recovery)
 * - `active`: generating tokens (between a sample and its stop token)
 * - `awaiting_tool`: a tool call, nudge or recovery turn is pending admission
 * - `disposed`: branch pruned, agent no longer usable
 *
 * `extracting` is a separate, one-way latch orthogonal to status: an agent
 * producing its forced recovery report is `awaiting_tool` while the turn is
 * pending and `active` while it decodes.
 *
 * @category Agents
 */
export type AgentStatus = 'idle' | 'active' | 'awaiting_tool' | 'disposed';

/**
 * How the agent's findings were produced — provenance for trace/debugging.
 *
 * @category Agents
 */
export type ResultSource =
  | 'voluntary_return' // agent voluntarily returned via the terminal tool
  | 'free_text'        // agent emitted prose without tool call
  | 'recovery'         // extracted by a forced recovery turn after a drop
  | 'nudge'            // agent returned after nudge injection
  | 'tool_error';      // tool threw, error captured as findings

// ── Format config ───────────────────────────────────────────

/**
 * Immutable prompt format configuration set at agent creation.
 * Derived from `formatChatSync()` output.
 *
 * @category Agents
 */
export interface FormatConfig {
  format: number;
  reasoningFormat: number;
  generationPrompt: string;
  parser: string;
  grammar: string;
  grammarLazy: boolean;
  grammarTriggers: GrammarTrigger[];
  /**
   * Whether the template's generation prompt includes `<think>\n` prefill.
   * Must match the value used in every subsequent delta builder call
   * (tool_result, nudge, etc.) for this agent — otherwise the parser's
   * `generation_prompt` diverges from actual KV state and reasoning
   * content leaks into visible content.
   * Captured once at agent setup from the pool's `enableThinking` option.
   */
  enableThinking: boolean;
}

// ── Tool history ────────────────────────────────────────────

/**
 * Metadata for a single tool invocation — what was called, how expensive
 * it was, and what context remained after. Content is in the branch KV;
 * this is the metadata the policy reads for informed decisions.
 *
 * @category Agents
 */
export interface ToolHistoryEntry {
  /** Tool name (e.g. 'web_search', 'fetch_page') */
  name: string;
  /** Summarized arguments (e.g. query string, URL) */
  args: string;
  /** KV CELLS this tool's result cost — not tokens. Equal on the token rail;
   *  on the embedding rail a returned image costs cells that no token count
   *  describes, and this is the number admission actually spent. */
  resultCells: number;
  /** Context available percent after this result settled */
  contextAfterPercent: number;
  /** Timestamp (performance.now) when result was recorded */
  timestamp: number;
}

// ── Agent ───────────────────────────────────────────────────

/**
 * An agent is a branch with intent.
 *
 * A Branch is a forkable KV cache sequence — it stores every token the
 * model has seen and generated. An Agent adds: a task to accomplish,
 * a policy for how to accomplish it, and a record of what it has done.
 *
 * The branch is the ground truth. The agent is the interpretation layer
 * that gives meaning to what's in the branch and makes decisions about
 * what to do next.
 *
 * Agents are plain classes — not Effection resources, not spawned
 * concurrently. The pool creates agents, manages their scope, and runs
 * the tick loop. The agent encapsulates state, policy, and findings.
 *
 * @category Agents
 */
export class Agent {
  // ── Identity ────────────────────────────────────────────

  /** Stable identifier — equals branch.handle */
  readonly id: number;

  /** Parent branch handle — trace metadata for UI tree reconstruction */
  readonly parentId: number;

  /** The KV sequence this agent owns */
  readonly branch: Branch;

  /** Immutable prompt format configuration */
  readonly fmt: FormatConfig;

  /** The task text this agent was assigned — used by echo detection guard */
  readonly task: string;

  /**
   * Optional non-enforcing label naming the Ability a spawn nominally belongs
   * to (`SpawnSpec.assignedAbility`), or `null` for harness-internal spawns.
   * Purely informational since the authGuard moved the security boundary
   * into the tool: tool access is gated by {@link Tool.protected}
   * + session grants, not by ability membership. Carried so trace events
   * (`tool:authReject`) and harness UI can attribute work to an ability.
   */
  readonly assignedAbility: string | null;

  // ── Mutable state ───────────────────────────────────────

  private _status: AgentStatus = 'idle';
  private _statusSignal: Signal<AgentStatus, void> = createSignal<AgentStatus, void>();
  private _startedAt: number | null = null;
  private readonly _clock: () => number;
  private _rawOutput = '';
  private _tokenCount = 0;
  private _toolCallCount = 0;
  private _turns = 0;
  private _result: string | null = null;
  private _resultSource: ResultSource | null = null;
  /**
   * Why this agent stopped, when it did not stop of its own accord.
   *
   * The pool already computes this at every drop site and writes it to the
   * trace as `pool:agentDrop.reason`. It is recorded here so it can ride the
   * AgentResult: a caller holding a `result` string otherwise cannot tell a
   * considered report from one squeezed out under a critical kill, and every
   * downstream consumer — a dag dependent especially — treats the two alike.
   *
   * `undefined` means the agent finished on its own terms.
   */
  exitReason: AgentExitReason | undefined = undefined;
  private _toolHistory: ToolHistoryEntry[] = [];
  private _nestedResults: string[] = [];
  private _traceBuffer: TraceToken[] = [];
  private _currentTool: string | null = null;
  private _toolObserved = false;
  private _parsed: ParseChatOutputResult | null = null;
  // True while the agent produces its forced recovery report (the in-loop
  // `parallel` recovery path): PRODUCE routes its isStop to finishRecovery
  // instead of onProduced, and the kill/reap guards skip it.
  private _extracting = false;
  // Per-recovery cap for the in-loop recovery report. `_recoveryBudget` is the token
  // target the pool set (policy.recoveryBudget, else a headroom share across the live
  // agents); the token-stop fires once the report's own tokens reach it.
  // `_recoveryTokenBase` snapshots the cumulative `_tokenCount` at recovery entry so
  // the cap counts ONLY the report's tokens (resetTurn clears rawOutput, not _tokenCount).
  private _recoveryBudget = 0;
  private _recoveryTokenBase = 0;
  // Base for `turnTokens` — re-snapshotted by resetTurn, so the voluntary
  // report cap counts only the CURRENT turn's tokens.
  private _turnTokenBase = 0;

  /** The agent that called the tool which spawned this agent's pool (null for top-level) */
  readonly parent: Agent | null = null;

  // ── Pool bookkeeping (one fact, one place — on the agent it is about) ──

  /**
   * The terminal `agent:failed` reason, once one has been announced. An agent
   * with this set is DISCARDED: never force-recovered by the close sweep,
   * never handed a late tool completion. `null` while it is live or finished
   * on its own terms.
   */
  failed: string | null = null;
  /** The branch holds cells nothing will read again; the next prune pass
   *  reclaims it (a leaf only — a branch with live children keeps its prefix). */
  pruneRequested = false;
  /** The spec this agent was born from — what a heal reproduces. */
  spec: AgentTaskSpec | null = null;
  /** Every KV delta since spawn, in order — the heal's replay material. */
  readonly records: AgentTurnRecord[] = [];
  /** How many times this lineage has been healed (a replacement inherits +1). */
  healAttempt = 0;
  /** The heal this agent is owed after a poison — its lineage, recorded by the
   *  ladder at the failure and forged by the loop at the next observe, after
   *  the prune pass, so the replacement asks for a lease once this branch has
   *  given its own back. Cleared when forged, whether or not the forge succeeds. */
  heal: Lineage | null = null;
  /** rc==1 deferrals of this agent's pending item; cleared when one lands. */
  deferAttempts = 0;
  /** Serial recovery: the report is uncapped and one runs at a time. */
  recoverySerial = false;

  // ── Constructor ─────────────────────────────────────────

  constructor(opts: {
    id: number;
    parentId: number;
    branch: Branch;
    fmt: FormatConfig;
    parent?: Agent | null;
    task?: string;
    /** Optional non-enforcing ability label — see {@link assignedAbility}. */
    assignedAbility?: string | null;
    /** The clock `startedAt` stamps through — the pool passes its run clock
     *  (wall time minus paused spans) so time budgets never count a pause.
     *  @default performance.now */
    clock?: () => number;
  }) {
    this.id = opts.id;
    this.parentId = opts.parentId;
    this.branch = opts.branch;
    this.fmt = opts.fmt;
    this.task = opts.task ?? '';
    this.parent = opts.parent ?? null;
    this.assignedAbility = opts.assignedAbility ?? null;
    this._clock = opts.clock ?? (() => performance.now());
  }

  // ── Status ──────────────────────────────────────────────

  get status(): AgentStatus { return this._status; }

  /**
   * Signal that fires on every status transition. Used by `PoolContext.waitFor`
   * to suspend until the agent reaches a terminal status. Multi-subscriber —
   * every active listener receives every transition.
   */
  get statusSignal(): Signal<AgentStatus, void> { return this._statusSignal; }

  /**
   * Transition to a new status. Enforces valid transitions:
   * - idle → active (first produce)
   * - active → awaiting_tool (tool call parsed)
   * - active → idle (stop token, report, or kill)
   * - awaiting_tool → active (tool result settled)
   * - awaiting_tool → idle (settle reject + kill)
   * - idle → disposed (branch pruned)
   *
   * Emits the new status via `statusSignal` for orchestrator-side observers.
   */
  transition(to: AgentStatus): void {
    const from = this._status;
    const valid =
      (from === 'idle' && (to === 'active' || to === 'disposed')) ||
      (from === 'active' && (to === 'awaiting_tool' || to === 'idle')) ||
      (from === 'awaiting_tool' && (to === 'active' || to === 'idle'));
    if (!valid) {
      throw new Error(`Invalid agent status transition: ${from} → ${to}`);
    }
    this._status = to;
    if (to === 'active' && this._startedAt === null) {
      this._startedAt = this._clock();
    }
    this._statusSignal.send(to);
  }

  /**
   * Wall-clock timestamp (performance.now) when the agent first became active.
   * Null until the first idle→active transition. Used by policies to measure
   * per-agent elapsed time independent of when the enclosing pool was created.
   */
  get startedAt(): number | null { return this._startedAt; }

  // ── Token accounting ────────────────────────────────────

  get rawOutput(): string { return this._rawOutput; }
  get tokenCount(): number { return this._tokenCount; }
  get toolCallCount(): number { return this._toolCallCount; }
  get turns(): number { return this._turns; }
  get traceBuffer(): TraceToken[] { return this._traceBuffer; }
  get currentTool(): string | null { return this._currentTool; }
  get parsed(): ParseChatOutputResult | null { return this._parsed; }
  /** Whether this agent is mid forced-recovery-report (in-loop parallel path). */
  get extracting(): boolean { return this._extracting; }
  /** The fixed per-recovery token cap for this recovery (set at {@link markExtracting}). */
  get recoveryBudget(): number { return this._recoveryBudget; }
  /** Tokens produced SINCE recovery entry — what the token-stop backstop checks. */
  get recoveryTokens(): number { return this._tokenCount - this._recoveryTokenBase; }
  /** Tokens produced in the CURRENT turn — what the voluntary report cap checks. */
  get turnTokens(): number { return this._tokenCount - this._turnTokenBase; }
  /** Mark the agent as producing its recovery report (idempotent, one-way). Records
   *  the per-recovery budget `b` (Infinity = uncapped) and snapshots the token base
   *  for the cap. */
  markExtracting(budget: number, serial = false): void {
    this._extracting = true;
    this._recoveryBudget = budget;
    this._recoveryTokenBase = this._tokenCount;
    this.recoverySerial = serial;
  }

  /** Accumulate generated token text into the current turn */
  accumulateToken(text: string): void {
    this._rawOutput += text;
    this._tokenCount++;
  }

  /** Accumulate token with trace data */
  accumulateTokenWithTrace(text: string, entropy: number, surprisal: number): void {
    this._rawOutput += text;
    this._tokenCount++;
    this._traceBuffer.push({ text, entropy, surprisal });
  }

  /**
   * Partial-parse the in-progress rawOutput to detect which tool the agent
   * is generating. Uses parseChatOutput with isPartial:true — format-agnostic
   * across all model families llama.cpp supports. Latches on first detection:
   * subsequent calls short-circuit without parsing.
   */
  observe(ctx: SessionContext): void {
    if (this._toolObserved) return;
    this._parsed = ctx.parseChatOutput(this._rawOutput, this.fmt.format, {
      reasoningFormat: this.fmt.reasoningFormat,
      generationPrompt: this.fmt.generationPrompt,
      parser: this.fmt.parser,
      isPartial: true,
    });
    if (this._parsed.toolCalls.length > 0) {
      this._currentTool = this._parsed.toolCalls[0].name;
      this._toolObserved = true;
    }
  }

  /**
   * Strict parse at isStop — replaces the standalone parseChatOutput call in
   * the pool's PRODUCE phase. Returns the full ParseChatOutputResult for
   * downstream consumers (trace writer, policy.onProduced).
   */
  finalize(ctx: SessionContext): ParseChatOutputResult {
    this._parsed = ctx.parseChatOutput(this._rawOutput, this.fmt.format, {
      reasoningFormat: this.fmt.reasoningFormat,
      generationPrompt: this.fmt.generationPrompt,
      parser: this.fmt.parser,
    });
    if (!this._currentTool && this._parsed.toolCalls.length > 0) {
      this._currentTool = this._parsed.toolCalls[0].name;
    }
    return this._parsed;
  }

  /** Reset per-turn output after tool result is settled */
  resetTurn(): void {
    this._rawOutput = '';
    this._currentTool = null;
    this._toolObserved = false;
    this._parsed = null;
    this._turnTokenBase = this._tokenCount;
  }

  /** Increment turn counter */
  incrementTurns(): void { this._turns++; }

  /** Increment tool call counter */
  incrementToolCalls(): void { this._toolCallCount++; }

  // ── Tool history ────────────────────────────────────────

  get toolHistory(): readonly ToolHistoryEntry[] { return this._toolHistory; }

  /** Record metadata for a completed tool invocation */
  recordToolResult(entry: ToolHistoryEntry): void {
    this._toolHistory.push(entry);
  }

  // ── Child findings ─────────────────────────────────────────

  /** Findings collected from recursive tool results (inner sub-agent findings) */
  get nestedResults(): readonly string[] { return this._nestedResults; }

  /** Collect inner findings from a recursive tool's result */
  addNestedResults(results: string[]): void {
    this._nestedResults.push(...results);
  }

  /**
   * Walk the agent lineage (self → caller → caller's caller → ...),
   * collecting results from each ancestor via the provided function.
   *
   * Self is visited first, then the calling agent, then its caller, etc.
   * Iterative — no stack overflow on deep recursion chains.
   *
   * @example Check if any ancestor fetched a URL
   * ```typescript
   * const fetched = agent.walkAncestors(a => a.toolHistory)
   *   .some(h => h.name === 'fetch_page' && h.args === url);
   * ```
   */
  walkAncestors<T>(fn: (agent: Agent) => readonly T[]): T[] {
    const result: T[] = [...fn(this)];
    let current = this.parent;
    while (current) {
      result.push(...fn(current));
      current = current.parent;
    }
    return result;
  }

  // ── Findings ────────────────────────────────────────────

  get result(): string | null { return this._result; }
  get resultSource(): ResultSource | null { return this._resultSource; }

  /** Set the agent's result with provenance tracking — single write path */
  setResult(content: string, source: ResultSource): void {
    this._result = content;
    this._resultSource = source;
  }

  // ── Branch-derived readings ─────────────────────────────

  /**
   * Branch metrics harvested just before the pool pruned this agent's branch.
   * A branch's perplexity accumulators die with it (metrics live in the
   * branch, not the agent), so every pool prune path calls
   * {@link harvestMetrics} first; `pool:close` and the AgentResult read the
   * harvest when `branch.disposed`. Null until harvested.
   */
  finalPpl: number | null = null;
  finalSamplingPpl: number | null = null;

  /** Capture branch metrics ahead of a prune — no-op once the branch is gone. */
  harvestMetrics(): void {
    if (this.branch.disposed) return;
    this.finalPpl = this.branch.perplexity;
    this.finalSamplingPpl = this.branch.samplingPerplexity;
  }

  get position(): number { return this.branch.position; }
  get forkHead(): number { return this.branch.forkHead; }
  /** Number of unique KV cells this agent owns above the fork point */
  get uniqueCells(): number { return this.branch.position - this.branch.forkHead; }

  /** Whether the grammar allows free text output (not tool-call-only) */
  get grammarAllowsFreeText(): boolean {
    return !this.fmt.grammarLazy || !this.fmt.grammar;
  }

  // ── Lifecycle ───────────────────────────────────────────

  /** Mark agent as disposed — called by pool when branch is pruned */
  dispose(): void {
    this._status = 'disposed';
    this._statusSignal.send('disposed');
  }
}
