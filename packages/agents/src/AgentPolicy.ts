import type { Agent } from './Agent';
import type { ToolLifecycleHooks } from './Tool';
import { ContextPressure } from './pressure';
import type { ParsedToolCall } from '@lloyal-labs/sdk';
import type { PressureThresholds } from './types';
import { renderTemplate } from './prompt';
import { retryUpTo } from './hooks';

// Recovery-phase accounting constants. These size the reserve a recovery turn
// needs out of the hard limit: the recovery prompt's own cost, plus room for
// the decoder's batch workspace. Used to compute the budget communicated to
// the model in its recovery prompt.
export const RECOVERY_PROMPT_OVERHEAD = 150;
export const BATCH_BUFFER = 512;


/**
 * Convert a token budget to a conservative word count for the model-facing
 * prompt. Tokens are tokenizer-specific; words are universal and better
 * reflected in training data. Applies a 0.7 words/token ratio (vs the
 * typical ~0.75) to under-advertise the budget, rounds down to the nearest
 * 10, and floors at 10 so the model always has a non-zero target.
 *
 * Capped at 1200: these advisories shape PRESSURE reports (wrap-up nudges,
 * recovery extraction), where a huge headroom figure reads as an invitation
 * to fill it — models pad and repeat toward the number they're given. The
 * exact figure still shows whenever headroom is genuinely below the cap.
 */
export function tokenBudgetAsWords(budgetTokens: number): number {
  return Math.min(1200, Math.max(10, Math.floor(budgetTokens * 0.7 / 10) * 10));
}

// ── Action types ────────────────────────────────────────────

/**
 * Why the agent entered idle status.
 * @category Agents
 */
export type IdleReason =
  | 'pressure_softcut'
  | 'max_turns'
  | 'free_text_stop';

/**
 * Action returned by policy.onProduced — tells the pool what to do.
 * @category Agents
 */
export type ProduceAction =
  | { type: 'tool_call'; tc: ParsedToolCall }
  | { type: 'return'; result: string }
  /** Replace the call with `message`, which the model reads in the result's place. */
  | { type: 'nudge'; message: string }
  | { type: 'idle'; reason: IdleReason }
  | { type: 'free_text_return'; content: string };

/**
 * Action returned by policy.onRecovery — what to do with an agent
 * that was killed without reporting.
 * @category Agents
 */
export type RecoveryAction =
  | { type: 'extract'; prompt: { system: string; user: string } }
  | { type: 'skip' };

// ── The harness's part of the tool lifecycle: data ─────────

/**
 * Whose attended calls a gate counts: the agent's own lineage (itself and, by
 * the fork, its ancestors) or the whole pool cohort.
 *
 * @category Agents
 */
export type GuardScope = 'lineage' | 'cohort';

/**
 * A harness's overrides of declared gates, by gate name: `false` skips the
 * gate, `{ scope }` re-scopes it. JSON-shaped, so it lives in harness config
 * and rides into the policy as a value. The framework's own gates are never
 * subject to it.
 *
 * @category Agents
 */
export type GuardOverrides = Readonly<Record<string, false | { scope: GuardScope }>>;

/**
 * The one runtime check of a {@link GuardOverrides} value, for the config rung
 * that reads it from YAML or JSON.
 *
 * @category Agents
 */
export function isGuardOverrides(v: unknown): v is GuardOverrides {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((o) =>
    o === false ||
    (typeof o === 'object' && o !== null && !Array.isArray(o) &&
      ((o as { scope?: unknown }).scope === 'lineage' || (o as { scope?: unknown }).scope === 'cohort')),
  );
}

// ── Policy interface ────────────────────────────────────────

/**
 * Agent lifecycle policy — the harness's per-agent decisions: what a
 * finished turn becomes, when an agent exits, how a reaped agent recovers,
 * the pressure thresholds, and its part of the tool lifecycle (as data).
 *
 * The pool consults the policy about ONE agent at a time, given a pressure
 * value; it never sees the cohort. Gates are not the policy's to run: the
 * pool runs every gate — the framework's, the called tool's, the policy's —
 * before `onProduced` is asked, so a refused call never reaches it.
 *
 * @category Agents
 */
export interface AgentPolicy {
  /**
   * PRODUCE phase: agent hit stop token — what should happen?
   *
   * Called after parseChatOutput extracts content and/or tool calls, and after
   * the gates admitted the call (if any). Policy decides based on: parsed
   * output, pressure, agent history, terminal tool config, grammar constraints.
   */
  onProduced(
    agent: Agent,
    parsed: { content: string | null; toolCalls: ParsedToolCall[] },
    pressure: ContextPressure,
    config: PolicyConfig,
  ): ProduceAction;

  /**
   * DISPATCH phase: should this tool call explore or exploit?
   *
   * When true (explore), content-boundary tools use agent-local scoring only.
   * When false (exploit), admission also scores against the original question and ranks by min().
   * Non-monotonic — flips with live pressure. Separate from lifecycle.
   * Optional — defaults to true (explore) when absent.
   */
  shouldExplore?(agent: Agent, pressure: ContextPressure): boolean;

  /**
   * PRODUCE phase (pre-produceSync): should this agent be killed immediately?
   *
   * Called before the agent generates any tokens. Returns true to kill —
   * no nudge possible here (there's no tool call to attach a message to).
   * The branch stays alive for recovery via {@link onRecovery}.
   *
   * Signatures are narrow by design: `(agent, pressure)`. The policy is a
   * class — time, cost, or other signals live on `this` (e.g. `_startTime`).
   * The pool passes what it owns; the policy combines with its own state.
   *
   * Optional — defaults to `pressure.critical` when absent.
   */
  shouldExit?(agent: Agent, pressure: ContextPressure): boolean;

  /**
   * Pressure thresholds for `ContextPressure`. The pool reads this once at
   * setup. Optional — defaults to ContextPressure.DEFAULT_SOFT_LIMIT /
   * DEFAULT_HARD_LIMIT.
   */
  readonly pressureThresholds?: PressureThresholds;

  /**
   * The harness's contribution to the tool lifecycle, as data: values of the
   * one contract every tool declares its own in ({@link ToolLifecycleHooks}).
   * At each position the pool walks the called tool's hooks, then these in
   * order, then the framework's defaults; the first concrete decision wins.
   * Optional — a policy with no opinion about tool calls contributes nothing,
   * and still gets authorization and every tool's own gates.
   */
  readonly hooks?: readonly ToolLifecycleHooks[];

  /**
   * The harness's overrides of declared gates, by name ({@link GuardOverrides}).
   * Applied to the tool's gates and to this policy's; never to the framework's.
   * Optional.
   */
  readonly guardOverrides?: GuardOverrides;

  /**
   * Reset per-tick state (e.g. trailing stop flags).
   * Called by the pool at the start of each tick iteration.
   * Optional — only needed if the policy tracks per-tick state.
   */
  resetTick?(): void;

  /**
   * Bind the pool's run clock — wall time minus paused spans. Called once at
   * pool boot when the pool has a {@link Pause} signal, so time budgets
   * measure the RUN's effort, never a pause. Optional — a policy without
   * time knobs can ignore it; absent binding, time reads `performance.now`.
   */
  bindClock?(clock: () => number): void;

  /**
   * Recovery: should we force a report from this reaped agent (no result)?
   *
   * Called when an agent is reaped without a voluntary result. Return
   * `extract` with a recovery prompt to inject as an in-loop forced
   * terminal-tool turn; return `skip` to prune. The pool forces the native
   * terminal-tool grammar (built from the designated terminal tool's schema
   * via `formatChat`, `toolChoice:'auto'`) and extracts the result via
   * `parseChatOutput` → `toolCalls` → the terminal tool's argument — generic
   * over the designated terminal (`report`/`submit`/…), not a hand-emitted
   * `{result}` JSON. The prompt is your recovery instruction; the grammar
   * (not the prompt) shapes the output.
   *
   * Optional — defaults to skip when absent.
   *
   * `budgetTokens` (optional) overrides the pressure-derived report budget —
   * the in-loop (parallel / wind-down) recovery passes the per-recovery budget `b`
   * so the prompt's advisory word count matches the pool's token-stop. Absent →
   * the budget is derived from `pressure.remaining` (the staggered / full-headroom
   * per-agent path).
   */
  onRecovery?(agent: Agent, pressure: ContextPressure, budgetTokens?: number): RecoveryAction;

  /**
   * Recovery reap shape.
   * `'staggered'` (default) — recover one agent at a time (serial recovery),
   * pruning each before the next so every report gets the full freed headroom
   * (uncapped, lossless; the high-effort path).
   * `'parallel'` — recover killed-without-result agents IN-LOOP: the recovery turn
   * is bin-packed into the tick loop alongside live siblings, capped at a per-recovery
   * budget `b` (the prompt's word advisory + the pool's token-stop), and only as many
   * reports are admitted as fit `(prompt + b)` in the current headroom — the rest wait
   * for the next tick, once the admitted ones are pruned. Wind-down always uses this
   * shape regardless of the setting. Absent → `'staggered'`.
   */
  recoveryShape?: 'staggered' | 'parallel';

  /**
   * Explicit token cap, enforced in two places:
   * - a cohort recovery turn (`'parallel'`, and wind-down in either shape) —
   *   rendered into the recovery prompt as a word advisory AND enforced by the
   *   pool's token-stop;
   * - a voluntary terminal report, in EITHER shape — the in-flight call is cut
   *   and salvaged once it has run this many tokens.
   *
   * Serial (`'staggered'`) forced recovery has no configured cap: it ends at its
   * stop token or when the pressure turns critical.
   *
   * Absent → adaptive for cohort turns (a fair share of current headroom across
   * the agents that will still hold context, clamped to a [min, max]) and 2048
   * for a voluntary report.
   */
  readonly recoveryBudget?: number;
}

/**
 * Pool-level facts handed to `onProduced`: the turn cap, the terminal tool
 * (if any), and whether the pool has tools besides it.
 * @category Agents
 */
export interface PolicyConfig {
  maxTurns: number;
  terminalToolName?: string;
  hasNonTerminalTools: boolean;
}

// ── Default policy ──────────────────────────────────────────

/**
 * Configuration for {@link DefaultAgentPolicy}.
 * @category Agents
 */
export interface DefaultAgentPolicyOpts {
  /** Min non-terminal tool calls before a return is accepted without nudge. @default 2 */
  minToolCallsBeforeReturn?: number;
  /**
   * Explore/exploit thresholds — both axes checked independently.
   * Either falling below its threshold flips the policy into exploit mode
   * (rerank tool results against the original query via the entailment
   * scorer). Explore mode preserves the agent's local-query ordering.
   */
  shouldExplore?: {
    /** Minimum fraction of context capacity (0–1) that must remain free for
     *  explore mode. Checks `pressure.percentAvailable / 100`. Below this
     *  fraction, exploit mode kicks in. @default 0.4 */
    context?: number;
    /** Maximum fraction of the time soft limit (0–1) that can be consumed
     *  before exploit mode kicks in. When `elapsed / timeSoftLimit >= time`,
     *  `shouldExplore` returns false regardless of context headroom. Only
     *  applies when `budget.time.softLimit` is set. @default 0.5 */
    time?: number;
  };
  /** Recovery extraction for agents killed without reporting.
   *  Policy decides per-agent via {@link AgentPolicy.onRecovery}. */
  recovery?: {
    prompt: { system: string; user: string };
    /** Skip extraction for agents with fewer tokens than this. @default 100 */
    minTokens?: number;
    /** Skip extraction for agents with fewer tool calls than this. @default 2 */
    minToolCalls?: number;
  };
  /** Recovery reap shape — see {@link AgentPolicy.recoveryShape}. @default 'staggered' */
  recoveryShape?: 'staggered' | 'parallel';
  /** See {@link AgentPolicy.recoveryBudget} — the one contract; the consumer
   *  sets it per Effort level. @default unset */
  recoveryBudget?: number;
  /** Budget thresholds. softLimit = nudge, hardLimit = kill.
   *  Same naming pattern for both resource types.
   *  time budget is global across nesting levels (ms since policy creation). */
  budget?: {
    /** Context budget (tokens remaining). softLimit = nudge floor, hardLimit = kill floor.
     *  COUPLING (non-obvious): RECOVERY budgets from the `hardLimit` RESERVE, not `softLimit`.
     *  The recovery budget `b` and the admission of an extracting agent's recovery turn draw
     *  from `remaining − hardLimit` (see {@link AgentPolicy.onRecovery} + the scheduler's
     *  `recoveryFor`), so recovery may decode the soft reserve down to `hardLimit`. `softLimit`
     *  is the model NUDGE floor, reserved for downstream work (synth) — raising it nudges
     *  EARLIER but does NOT shorten recovery reports. (`softLimit` is advisory: it gates the
     *  wrap-up nudge + tool-result deferral, never a kill; `hardLimit` is the only mechanical
     *  floor.) */
    context?: { softLimit?: number; hardLimit?: number };
    /** Wall-time budget (ms since policy creation). */
    time?: { softLimit?: number; hardLimit?: number };
  };
  /** Terminal tool name. When set, agents mid-generation of this tool are
   *  protected from shouldExit — the hard limit is deferred until the tool
   *  call completes naturally or pressure forces a kill. */
  terminalToolName?: string;
  /** How many times a transient tool failure is retried before the call fails
   *  with a directive result — this policy's `afterExecute` entry. @default 1 */
  maxToolRetries?: number;
  /** The harness's tool-lifecycle contributions — see {@link AgentPolicy.hooks}.
   *  Walked in order, before this policy's own opinions. */
  hooks?: readonly ToolLifecycleHooks[];
  /** The harness's gate overrides — see {@link AgentPolicy.guardOverrides}. */
  guardOverrides?: GuardOverrides;
}

/**
 * The default policy: routes a finished turn (no call → free text or idle;
 * the terminal tool → return, or a nudge to use tools first; over budget → a
 * report-now nudge, once per tick; else dispatch), exits on critical pressure
 * or a time hard limit, recovers by extraction, and contributes one entry to
 * the tool lifecycle: its retry budget and its settle nudge.
 *
 * @category Agents
 */
export class DefaultAgentPolicy implements AgentPolicy {
  private _minToolCalls: number;
  private _exploreContext: number;
  private _exploreTime: number;
  private _forceExploit = false;
  private _recovery: DefaultAgentPolicyOpts['recovery'] | null;
  private _recoveryShape: 'staggered' | 'parallel';
  private _recoveryBudget: number | null;
  private _budget: DefaultAgentPolicyOpts['budget'] | null;
  private _terminalToolName: string | null;
  private _maxToolRetries: number;
  private _startTime: number;
  private _clock: () => number = () => performance.now();

  /**
   * The harness's hooks in order, then this policy's own opinions as one more
   * value of the same type: its retry budget (`maxToolRetries`) and its settle
   * nudge (report now, when the pool has a terminal and the agent has used a
   * tool). A harness entry therefore beats the class opinion, and the class
   * opinion beats the framework default.
   */
  readonly hooks: readonly ToolLifecycleHooks[];
  readonly guardOverrides: GuardOverrides | undefined;

  constructor(opts?: DefaultAgentPolicyOpts) {
    this._minToolCalls = opts?.minToolCallsBeforeReturn ?? 2;
    this._exploreContext = opts?.shouldExplore?.context ?? 0.4;
    this._exploreTime = opts?.shouldExplore?.time ?? 0.5;
    this._recovery = opts?.recovery ?? null;
    this._recoveryShape = opts?.recoveryShape ?? 'staggered';
    this._recoveryBudget = opts?.recoveryBudget ?? null;
    this._budget = opts?.budget ?? null;
    this._terminalToolName = opts?.terminalToolName ?? null;
    this._maxToolRetries = opts?.maxToolRetries ?? 1;
    this._startTime = performance.now();
    this.guardOverrides = opts?.guardOverrides;
    this.hooks = [...(opts?.hooks ?? []), this._ownHooks()];
  }

  /** This policy's opinions about a tool call's life, as data. */
  private _ownHooks(): ToolLifecycleHooks {
    return {
      afterExecute: retryUpTo(this._maxToolRetries),
      beforeAdmit: ({ agent, pressure, terminal }) => {
        // Nudge if possible — stateless, no escalation tracking.
        if (terminal && agent.toolCallCount > 0) {
          const words = tokenBudgetAsWords(pressure.remaining - pressure.hardLimit);
          return { type: 'nudge', message: `Tool result too large for the remaining context. Report your findings now within ${words} words.` };
        }
        // No terminal tool: the agent cannot be told to report; drop it.
        return { type: 'drop' };
      },
    };
  }

  /**
   * Elapsed wall time for *this agent* (since its first idle→active transition),
   * falling back to the policy's own construction time when the agent hasn't
   * started yet (defensive — shouldn't normally happen).
   *
   * Per-agent timing means orchestrators that spawn agents sequentially (e.g.
   * `chain`) get the correct "how long has this task been running?" semantics
   * without the time budget leaking across iterations.
   */
  private _elapsed(agent?: Agent): number {
    const started = agent?.startedAt ?? this._startTime;
    return this._clock() - started;
  }

  /** Bind the pool's run clock (wall minus paused spans). `_startTime` was
   *  stamped pre-pool with the wall clock, when the two domains coincide —
   *  no rebasing needed; `agent.startedAt` stamps through the same clock. */
  bindClock(clock: () => number): void {
    this._clock = clock;
  }

  /** Pressure thresholds for `ContextPressure`. The pool reads this once at setup. */
  get pressureThresholds(): PressureThresholds {
    return {
      softLimit: this._budget?.context?.softLimit
        ?? ContextPressure.DEFAULT_SOFT_LIMIT,
      hardLimit: this._budget?.context?.hardLimit
        ?? ContextPressure.DEFAULT_HARD_LIMIT,
    };
  }

  /** Recovery reap shape. The pool reads this to pick in-loop bin-packed recovery
   *  (`parallel`) vs one serial report at a time (`staggered`). */
  get recoveryShape(): 'staggered' | 'parallel' {
    return this._recoveryShape;
  }

  /** Explicit per-recovery token budget for in-loop recovery (undefined = adaptive,
   *  a headroom share across live agents). Rendered into the prompt + enforced by
   *  the pool's token-stop. */
  get recoveryBudget(): number | undefined {
    return this._recoveryBudget ?? undefined;
  }

  onProduced(
    agent: Agent,
    parsed: { content: string | null; toolCalls: ParsedToolCall[] },
    pressure: ContextPressure,
    config: PolicyConfig,
  ): ProduceAction {
    const tc = parsed.toolCalls[0];
    if (!tc) return this._handleNoToolCall(agent, parsed);
    if (this._isTerminalTool(tc, config)) return this._handleTerminalTool(tc, agent, config, pressure);
    // Gates ran before this was called (the pool's applier, `hooks.ts`), so a
    // refused call never reaches the budget: its specific message beats a
    // generic "report now within N words" nudge (trace-1776819196054 agent 65539).
    if (this._isOverBudget(agent, tc, pressure, config)) return this._handleOverBudget(agent, tc, pressure, config);
    // Normal tool call
    return { type: 'tool_call', tc };
  }

  // ── onProduced decision predicates ─────────────────────

  private _handleNoToolCall(
    agent: Agent, parsed: { content: string | null },
  ): ProduceAction {
    if (!agent.result && agent.toolCallCount > 0 && parsed.content) {
      return { type: 'free_text_return', content: parsed.content };
    }
    return { type: 'idle', reason: 'free_text_stop' };
  }

  private _isTerminalTool(tc: ParsedToolCall, config: PolicyConfig): boolean {
    return !!(config.terminalToolName && tc.name === config.terminalToolName);
  }

  private _handleTerminalTool(
    tc: ParsedToolCall, agent: Agent, config: PolicyConfig, pressure: ContextPressure,
  ): ProduceAction {
    const underPressure = this._isUnderPressure(agent, pressure, config);
    if (agent.toolCallCount < this._minToolCalls && config.hasNonTerminalTools && !underPressure) {
      return { type: 'nudge', message: 'You must use tools before submitting results.' };
    }
    let result: string;
    try { result = JSON.parse(tc.arguments).result; } catch { result = tc.arguments; }
    return { type: 'return', result };
  }

  private _isUnderPressure(agent: Agent, pressure: ContextPressure, config: PolicyConfig): boolean {
    const timeSoft = this._budget?.time?.softLimit;
    const timeNudge = timeSoft != null && this._elapsed(agent) >= timeSoft;
    return agent.turns >= config.maxTurns || pressure.headroom < 0 || timeNudge;
  }

  private _isOverBudget(agent: Agent, tc: ParsedToolCall, pressure: ContextPressure, config: PolicyConfig): boolean {
    const underPressure = this._isUnderPressure(agent, pressure, config);
    return underPressure && (!config.terminalToolName || tc.name !== config.terminalToolName);
  }

  private _handleOverBudget(
    agent: Agent, tc: ParsedToolCall, pressure: ContextPressure, config: PolicyConfig,
  ): ProduceAction {
    const timeSoft = this._budget?.time?.softLimit;
    const timeNudge = timeSoft != null && this._elapsed(agent) >= timeSoft;

    if (config.terminalToolName && agent.toolCallCount > 0 && !pressure.critical) {
      if (!this._nudgedThisTick) {
        this._nudgedThisTick = true;
        // Budget the model can emit before `pressure.critical` kills it.
        // Overshoot → kill → the recovery turn extracts from the hardLimit reserve.
        // Expressed in words (not tokens) because tokenizers vary across
        // models but words are universal. Under-advertised + rounded down
        // so the model has slack on the ceiling.
        const words = tokenBudgetAsWords(pressure.remaining - pressure.hardLimit);
        const msg = timeNudge
          ? `Time limit reached — report your findings now within ${words} words.`
          : agent.turns >= config.maxTurns
            ? `Turn limit reached — report your findings now within ${words} words.`
            : `Context nearly full — report your findings now within ${words} words.`;
        return { type: 'nudge', message: msg };
      }
      return { type: 'tool_call', tc };
    }
    return { type: 'idle', reason: agent.turns >= config.maxTurns ? 'max_turns' : 'pressure_softcut' };
  }

  /**
   * UI-driven override. Harness calls this when the user wants agents
   * to wrap up. Overrides pressure-based logic immediately.
   */
  setExploitMode(force: boolean): void { this._forceExploit = force; }

  shouldExit(agent: Agent, pressure: ContextPressure): boolean {
    // Terminal-tool protection applies in the graceful zone only — once
    // `pressure.critical` fires, the agent must yield so the pool can
    // kill+recover before native OOM. Holding this protection through
    // critical territory was the DOJ runaway cause (trace-1776782401659).
    if (this._terminalToolName && agent.currentTool === this._terminalToolName && !pressure.critical) return false;

    if (!pressure.critical) {
      const timeHard = this._budget?.time?.hardLimit;
      if (timeHard != null && this._elapsed(agent) >= timeHard) return true;
      return false;
    }
    if (this._killedThisTick) return false;
    this._killedThisTick = true;
    return true;
  }

  shouldExplore(agent: Agent, pressure: ContextPressure): boolean {
    if (this._forceExploit) return false;
    const contextOk =
      pressure.percentAvailable / 100 > this._exploreContext;
    const timeSoftLimit = this._budget?.time?.softLimit;
    const timeOk =
      timeSoftLimit == null
        ? true
        : this._elapsed(agent) / timeSoftLimit < this._exploreTime;
    return contextOk && timeOk;
  }

  /**
   * Trailing stop: at most one agent nudged or killed per tick.
   * The sacrificed agent's findings are extracted and its context freed,
   * giving the remaining agents headroom to continue researching.
   * Both flags reset per tick via resetTick(), called by the pool.
   */
  private _killedThisTick = false;
  private _nudgedThisTick = false;

  resetTick(): void {
    this._killedThisTick = false;
    this._nudgedThisTick = false;
  }

  onRecovery(agent: Agent, pressure: ContextPressure, budgetTokensOverride?: number): RecoveryAction {
    if (!this._recovery) return { type: 'skip' };
    const minTokens = this._recovery.minTokens ?? 100;
    const minToolCalls = this._recovery.minToolCalls ?? 2;
    if (agent.tokenCount < minTokens || agent.toolCallCount < minToolCalls) {
      return { type: 'skip' };
    }
    // Budget recovery's generation can consume: hardLimit reserve minus the
    // recovery prompt's own cost and the decoder's batch workspace. Expressed
    // as words (not tokens) and under-advertised so the model has slack —
    // tokenizers vary across models but words are universal. Rendered into
    // the prompt as `it.budget` so authors can reference it via `<%= it.budget %>`.
    // In-loop recovery overrides this with its per-recovery budget `b` (a headroom
    // share across live agents) so the advisory matches the pool's token-stop
    // (graceful self-conclusion, not a guillotine).
    const budgetTokens = budgetTokensOverride
      ?? Math.max(50, pressure.remaining - RECOVERY_PROMPT_OVERHEAD - BATCH_BUFFER);
    const budget = tokenBudgetAsWords(budgetTokens);
    const tctx = { budget };
    return {
      type: 'extract',
      prompt: {
        system: renderTemplate(this._recovery.prompt.system, tctx),
        user: renderTemplate(this._recovery.prompt.user, tctx),
      },
    };
  }
}
