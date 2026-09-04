import { resource, call, ensure, createSignal, createChannel, spawn, scoped, each, sleep, action, race } from 'effection';
import type { Operation, Subscription, Task, Signal } from 'effection';
import { waitUntilSettled } from './combinators';
import type { Branch } from '@lloyal-labs/sdk';
import { CHAT_FORMAT_CONTENT_ONLY, CHAT_FORMAT_GENERIC, GrammarTriggerType, type ParsedToolCall, type SessionContext } from '@lloyal-labs/sdk';
import type { BranchStore } from '@lloyal-labs/sdk';
import { Ctx, Store, Trace, TraceParent, CallingAgent, SpineFmt, GrantStoreCtx, WindDown, CancelAgent, Pause, Attachments, Ingress } from './context';
import { prepareBatch } from './prepare-content';
import type { FormatConfig } from './Agent';
import { buildToolResultDelta, buildToolResultDeltaMultimodal, buildTurnDelta, buildUserDelta, decodeErrorOf, deltaCells } from '@lloyal-labs/sdk';
import type { MultimodalDelta } from '@lloyal-labs/sdk';
import type { Attachment } from '@lloyal-labs/media';
import { useTraceScope } from './trace-scope';

import type { TraceWriter } from './trace-writer';
import type { TraceEvent } from './trace-types';
import type { AgentPolicy, IdleReason, ToolRetryAction } from './AgentPolicy';
import { Agent } from './Agent';
import { replayAgentTurns } from './replay';
import type { AgentTurnRecord } from './replay';
import { DefaultAgentPolicy, RECOVERY_PREFILL_OVERHEAD, BATCH_BUFFER } from './AgentPolicy';
import type { PolicyConfig } from './AgentPolicy';
import { Tool, ToolRetryError, takeToolMedia, TOOL_CONTEXT_KEY, TOOL_IMAGE_ERROR_KEY } from './Tool';
import type {
  PressureThresholds,
  AgentTaskSpec,
  AgentPoolOptions,
  AgentPoolResult,
  AgentEvent,
  ToolContext,
} from './types';

// ── Agent state transitions ────────────────────────────────────
// idle → active         (first produce)
// active → awaiting_tool (tool call parsed)
// active → idle          (stop token, report, or kill)
// awaiting_tool → active (tool result settled)
// awaiting_tool → idle   (settle reject + kill)
// idle → disposed        (branch pruned)

// ── Self-healing ladder knobs (docs/self-healing.md) ─────────────────────
/** rc==1 (no KV slot, branch intact) deferrals per agent before the item
 *  escalates to the terminal path. */
const MAX_DEFER_ATTEMPTS = 3;
/** Consecutive fatal rcs (2 or < -1) before the pool stops laddering: a
 *  backend in a sticky error state (Metal after an OOM) fails every decode,
 *  and deferring or healing there burns budget for nothing. Reset by any
 *  successful dispatch. */
const BACKEND_TRIPWIRE_N = 3;
/** Heals per lineage. A replacement that poisons AGAIN goes terminal — a
 *  second failure on replayed state is evidence, not bad luck. */
const MAX_HEAL_ATTEMPTS = 1;

/** Minimal event sender interface — accepts any Channel close type */
type EventSender = { send(value: AgentEvent): Operation<void> };

type SettledTool = {
  agentId: number;
  toolName: string;
  callId: string;
  args: string;
  probe?: string;
} & (
  /** The token rail: the result tokenized here and prefills as tokens. */
  | { rail: 'token'; prefillTokens: number[]; media?: never; resultStr?: string }
  /** The embedding rail. `llama_batch` is token-XOR-embd, so this cannot join
   *  a token batch — a separate call, not a separate strategy. The delta stops
   *  at the string stage because mtmd tokenizes downstream, which is why the
   *  cost had to be MEASURED. */
  | {
      rail: 'media';
      /** The tool-result string the delta was built from — the heal record's
       *  replay material (docs/self-healing.md). */
      resultStr?: string;
      prefillTokens?: never;
      media: { delta: MultimodalDelta; cells: number; attachments: readonly Attachment[] };
    }
);

/**
 * What admission spends on this item — the ONE place that answers it.
 *
 * It used to be re-derived wherever it was needed, and one site forgot: the
 * stall-break passed `prefillTokens.length` to `policy.onSettleReject`, which
 * for a media item is `[]` and therefore **0**. Not "unknown" — a confident
 * zero, from which the policy decided whether an agent was worth keeping. A
 * union plus one accessor is what makes that site impossible to write.
 */
function settledCells(item: SettledTool): number {
  return item.rail === 'media' ? item.media.cells : item.prefillTokens.length;
}


/**
 * A fan-out tool's completion, pushed by its off-fiber child onto
 * `completedTools` and processed on the loop fiber in DRAIN. Carries
 * everything DRAIN needs to run the post-processing that the inline path runs
 * inline — that post-processing tokenizes/reads the main `llama_context`, so it
 * must stay on the loop fiber, never in the child.
 */
type ToolCompletion =
  | { kind: 'result'; agent: Agent; tc: ParsedToolCall; callId: string; dispatchTraceId: number; toolT0: number; result: unknown }
  | { kind: 'retry'; agent: Agent; tc: ParsedToolCall; callId: string; dispatchTraceId: number; toolT0: number; retryAttempt: number; err: ToolRetryError }
  | { kind: 'error'; agent: Agent; tc: ParsedToolCall; callId: string; dispatchTraceId: number; err: Error };

/** Default cap on concurrent fan-out tool children (Effection has no semaphore
 *  — a FIFO counting gate enforces it). Overridable per pool via
 *  {@link AgentPoolOptions.maxConcurrentTools}. Inline tools don't count: the
 *  loop fiber already serializes them. */
const DEFAULT_MAX_CONCURRENT_TOOLS = 8;

/** Normalize a thrown value to an `Error`. Tools — especially third-party —
 *  may throw non-Error values (`throw 'rate limited'`, `throw { code: 500 }`);
 *  an `err as Error` cast would leave `.message` undefined in the `tool:error`
 *  trace and the agent's result. */
function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** FIFO counting gate: acquire before a fan-out child's `execute`, release in
 *  an `ensure`. A halt while queued runs the action cleanup (drops the waiter);
 *  a halt before acquire returns never released, so callers guard release with
 *  a `took` flag. */
interface Permits { acquire(): Operation<void>; release(): void }
function makePermits(n: number): Permits {
  let available = n;
  const waiters: Array<() => void> = [];
  return {
    *acquire(): Operation<void> {
      if (available > 0) { available--; return; }
      yield* action<void>((resolve) => {
        const w = () => resolve();
        waiters.push(w);
        return () => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); };
      });
    },
    release(): void {
      const w = waiters.shift();
      if (w) w(); else available++;
    },
  };
}

/**
 * Immutable KV budget snapshot for one tick of the agent loop
 *
 * Frozen at phase boundaries (PRODUCE, SETTLE, DISPATCH) so that all
 * decisions within a phase are evaluated against the same baseline.
 * Without this, items processed earlier in a loop would see different
 * pressure than items processed later — making reject/nudge/kill
 * decisions order-dependent and nondeterministic.
 *
 * Created from `SessionContext._storeKvPressure()` which returns
 * `{ nCtx, cellsUsed, remaining }` where `remaining = nCtx - cellsUsed`.
 * `cellsUsed` tracks unique KV cells per branch — incremented on
 * `decode_each` / `decode_scatter`, decremented on release by
 * `position - fork_head` (unique cells above the fork point), reset on
 * bulk ops like `retainOnly` and `drain`.
 *
 * Two thresholds partition `remaining` into three zones:
 *
 * ```
 * ┌──────────────────────────────────────────────────────┐
 * │                    nCtx                              │
 * │  ┌──────────┬───────────────────┬──────────────────┐ │
 * │  │cellsUsed │    headroom > 0   │    softLimit     │ │
 * │  │ (in use) │   (new work OK)   │   (reserved)     │ │
 * │  └──────────┴───────────────────┴──────────────────┘ │
 * │              ◄── remaining ──►  │                    │
 * │                                 │                    │
 * │  headroom = remaining - softLimit                    │
 * │  critical = remaining < hardLimit                    │
 * └──────────────────────────────────────────────────────┘
 * ```
 *
 * - **headroom > 0** — room for new work (tool results, generation)
 * - **headroom ≤ 0** — over budget. SETTLE rejects tool results, PRODUCE
 *   hard-cuts non-terminal tool calls. Terminal tools still pass.
 * - **critical** — remaining below hardLimit. Agents killed before
 *   `produceSync()` to prevent llama_decode crashes.
 *
 * @category Agents
 */
export class ContextPressure {
  /** Default softLimit: 1024 tokens reserved for downstream work */
  static readonly DEFAULT_SOFT_LIMIT = 1024;
  /**
   * Default hardLimit: 512 tokens — matches llama.cpp's default `n_batch`.
   * The pool validates at startup that `hardLimit >= nBatch`; the default
   * is sized to satisfy the invariant for the default llama.cpp context.
   * Recovery fits within the `hardLimit` reserve.
   */
  static readonly DEFAULT_HARD_LIMIT = 512;
  /**
   * Assumed `nBatch` when the native binding doesn't expose it.
   * Pool startup validates `pressureThresholds.hardLimit >= this`.
   * TODO: once `SessionContext.nBatch` is exposed (lloyal.node
   * follow-up), read from ctx.nBatch instead.
   */
  static readonly ASSUMED_N_BATCH = 512;

  /** Total KV cache capacity, in CELLS. 0 when no context limit.
   *
   *  Not positions — the two diverge on the embedding rail. Under M-RoPE an
   *  image occupies far more cells than it advances position (measured on
   *  Qwen3.5: 564 cells for 32 positions, ~18x), so budgeting from a branch's
   *  position would under-count an image by that factor. Every number on this
   *  class is cells, and `cellsUsed` is what the cache actually reports. */
  readonly nCtx: number;
  /** KV cells currently in use (monotonic within a pool run). */
  readonly cellsUsed: number;
  /**
   * KV slots remaining (`nCtx - cellsUsed`).
   * Infinity when nCtx ≤ 0 (no context limit).
   */
  readonly remaining: number;
  /** Remaining KV floor — tokens reserved for downstream work */
  readonly softLimit: number;
  /** Crash-prevention floor — agents killed when remaining drops below */
  readonly hardLimit: number;

  constructor(ctx: SessionContext, opts?: PressureThresholds) {
    const p = ctx._storeKvPressure();
    this.nCtx = p.nCtx;
    this.cellsUsed = p.cellsUsed;
    this.remaining = p.nCtx <= 0 ? Infinity : p.remaining;
    this.softLimit = opts?.softLimit ?? ContextPressure.DEFAULT_SOFT_LIMIT;
    this.hardLimit = opts?.hardLimit ?? ContextPressure.DEFAULT_HARD_LIMIT;
  }

  /**
   * Tokens available for new work: `remaining - softLimit`.
   * Positive means room to accept tool results or continue generating.
   * Negative means over budget — SETTLE rejects, PRODUCE hard-cuts.
   */
  get headroom(): number { return this.remaining - this.softLimit; }

  /** `remaining < hardLimit` — agent must not call `produceSync()`. */
  get critical(): boolean { return this.remaining < this.hardLimit; }

  /** Can `tokenCount` tokens fit while staying above softLimit? */
  canFit(tokenCount: number): boolean { return tokenCount <= this.headroom; }

  /**
   * KV available as 0–100 integer. Single source of truth for the
   * percentage shown to agents (`contextAvailablePercent`), recorded
   * on tool history (`contextAfterPercent`), and used by
   * `policy.shouldExplore()`.
   */
  get percentAvailable(): number {
    return this.nCtx > 0
      ? Math.max(0, Math.round((this.remaining / this.nCtx) * 100))
      : 100;
  }
}

/** The grammar that forces an agent's recovery output to be a valid call to the
 *  pool's TERMINAL tool — whatever the harness designated (`report`, `submit`,
 *  `finish`, …; the framework never assumes a specific tool). Same native path
 *  every other call uses: `formatChat`'s tool grammar constrains generation, and
 *  `parseChatOutput` (chat_out / `common_chat_parse`) decodes the resulting Hermes
 *  tool-call into `{ name, arguments }`. Computed once per pool from the terminal
 *  tool's schema; `null` when the pool has no terminal tool (then recovery is a
 *  no-op — there is no structured result to force).
 *
 *  Built with `toolChoice: 'auto'` (root rule = the bare tool-call) and applied
 *  EAGERLY via `branch.setGrammar` at recovery — that forces a valid terminal call
 *  from token 0. `'required'` is WRONG here: it prefixes the grammar's root with the
 *  generation prompt (`"<|im_start|>assistant\n" …`), and since the recovery turn has
 *  already prefilled that prompt, a required grammar double-emits it and the model
 *  wanders into raw template tokens. Verified against the real model: required-eager
 *  → `<|im_start|>assistant…<think>…` prose; auto-eager → `<tool_call><function=…>`. */
type TerminalGrammar = string;

function buildTerminalGrammar(ctx: SessionContext, terminalTool: Tool): TerminalGrammar {
  return ctx.formatChatSync(
    JSON.stringify([{ role: 'system', content: '' }, { role: 'user', content: '' }]),
    { tools: JSON.stringify([terminalTool.schema]), toolChoice: 'auto', enableThinking: false },
  ).grammar;
}

// Adaptive per-report budget bounds for in-loop recovery when no explicit
// `policy.reportBudget` is set: `b` = a fair share of current headroom across the
// live agents, clamped to [MIN, MAX]. MIN keeps a forced report from being uselessly
// short under pressure; MAX stops one agent with a huge context from being told to
// write an essay.
const MIN_REPORT_BUDGET = 128;
const MAX_REPORT_BUDGET = 2048;

/** An unlimited context reads `remaining`/`headroom` as Infinity, which JSON
 *  cannot carry — serialize it as an explicit null (the trace types declare
 *  these fields nullable) instead of letting JSONL coerce it silently. */
function finiteOrNull(x: number): number | null {
  return Number.isFinite(x) ? x : null;
}

/** Prune an agent's branch only when it is a childless leaf. `Branch.pruneSync`
 *  is RESTRICT-mode (`Branch.ts`: throws when the branch has live children — they
 *  still need its KV prefix), so a recovered agent that sub-spawned must NOT be
 *  pruned: skip it and let the children's own teardown reclaim the lineage.
 *  Harvests the branch's perplexity first ({@link Agent.harvestMetrics}) — the
 *  metrics die with the branch, and `pool:close` reads the harvest. */
function safePrune(a: Agent, tw: TraceWriter, parentTraceId: number | null): void {
  a.harvestMetrics();
  if (!a.branch.disposed && a.branch.children.length === 0) {
    // The KV free is real and observable: record it (position read BEFORE the
    // prune — the branch is disposed after) so the trace shows frees, not
    // only growth (#104).
    tw.write({ traceId: tw.nextId(), parentTraceId, ts: performance.now(),
      type: 'branch:prune', branchHandle: a.branch.handle, position: a.branch.position });
    a.branch.pruneSync();
  }
}

/** Extract the terminal-tool result string from a parsed (possibly TRUNCATED)
 *  tool call. A clean call's `arguments` is valid JSON → `.result`. The token-stop
 *  backstop cuts mid-call, so `parseChatOutput` yields unclosed JSON like
 *  `{"result":"…partial` → `JSON.parse` throws; recover the `result` body from the
 *  partial and JSON-unescape it (dropping a dangling backslash) rather than leaking
 *  the `{"result":"` wrapper into the finding. Falls back to the raw arguments when
 *  there is no `result` key (a non-`{result}` terminal tool — matches
 *  `DefaultAgentPolicy._handleTerminalTool`). */
function extractTerminalResult(args: string): string {
  try {
    const r = JSON.parse(args).result;
    if (typeof r === 'string') return r;
  } catch { /* truncated or non-JSON — salvage the partial below */ }
  const m = args.match(/"result"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (m) {
    try { return JSON.parse(`"${m[1].replace(/\\+$/, '')}"`); } catch { /* fall through to raw */ }
  }
  return args;
}

/** The recovery turn (`onRecovery`'s system+user prompt) as a branch-prefill
 *  delta — a thin alias over the shared `buildUserDelta` builder (system + user
 *  turn, no thinking). Used by `recoverInline` (staggered) and `handleRecover`
 *  (the in-loop parallel path). */
function recoveryPromptTokens(
  ctx: SessionContext,
  recovery: { prompt: { system: string; user: string } },
): number[] {
  return buildUserDelta(ctx, recovery.prompt.user, {
    system: recovery.prompt.system,
    enableThinking: false,
  });
}

/** Parse a finished recovery branch's output, set the agent's result (source
 *  `'recovery'`), emit `agent:recovered`, and write the recovery traces.
 *  Returns true iff a result was extracted. Shared by both reap shapes. */
function* finishRecovery(
  agent: Agent,
  output: string,
  producedTokens: number,
  events: EventSender,
  tw: TraceWriter,
  parentTraceId: number,
  ctx: SessionContext,
  terminalToolName: string | undefined,
): Operation<boolean> {
  tw.write({
    traceId: tw.nextId(), parentTraceId, ts: performance.now(),
    type: 'pool:recoveryProduce', agentId: agent.id,
    tokenCount: producedTokens, outputLength: output.length,
  });
  // The forced recovery output is a TERMINAL-tool call in the model's native
  // Hermes syntax — decode it with the same parser the agent uses for every turn,
  // and extract the result with the same convention as a voluntary terminal return
  // (the `result` arg, falling back to the raw arguments), never assuming a specific
  // tool's shape. See AgentPolicy `_handleTerminalTool`.
  const parsed = ctx.parseChatOutput(output, agent.fmt.format, {
    reasoningFormat: agent.fmt.reasoningFormat,
    generationPrompt: agent.fmt.generationPrompt,
    parser: agent.fmt.parser,
  });
  // When a terminal tool is designated, the report MUST be that tool's call — never fall
  // back to a non-terminal call (that would set the result from the wrong args). With no
  // terminal tool, take whatever the model produced (matches `_handleTerminalTool`).
  const call = terminalToolName
    ? parsed.toolCalls.find(c => c.name === terminalToolName)
    : parsed.toolCalls[0];
  if (call) {
    const result = extractTerminalResult(call.arguments);
    if (result) {
      agent.setResult(stripDanglingToolCall(result), 'recovery');
      yield* events.send({ type: 'agent:recovered', agentId: agent.id, result: agent.result! });
      tw.write({
        traceId: tw.nextId(), parentTraceId, ts: performance.now(),
        type: 'pool:recoveryReturn', agentId: agent.id,
        resultLength: result.length,
      });
      return true;
    }
  }
  const reason = call ? 'empty_terminal_result' : 'no_terminal_call';
  tw.write({
    traceId: tw.nextId(), parentTraceId, ts: performance.now(),
    type: 'pool:recoveryFailed', agentId: agent.id,
    reason,
    outputExcerpt: output.slice(0, 200),
  });
  // Terminal UI signal: the agent stopped at the drop (`agent:done`) and is shown
  // "writing report"; without this it never leaves that state (eternal spinner).
  // `agent:failed` is the failure twin of `agent:recovered` — the consumer marks
  // the task failed instead of hanging. See trace `pool:recoveryFailed`.
  yield* events.send({ type: 'agent:failed', agentId: agent.id, reason });
  return false;
}

/** Finish an in-loop (`parallel`) recovery report — both the normal stop token and
 *  the token-stop backstop land here: extract + set the result, idle the agent,
 *  child-safe-prune the dead branch (freeing its KV for siblings), and tick the
 *  UI. `producedTokens` = the report's OWN tokens (`recoveryTokens`), since the
 *  cumulative `tokenCount` includes the agent's whole research run. */
function* completeExtraction(
  a: Agent, events: EventSender, tw: TraceWriter, parentTraceId: number,
  ctx: SessionContext, pressureOpts: PressureThresholds, terminalToolName: string | undefined,
): Operation<void> {
  yield* finishRecovery(a, a.rawOutput, a.recoveryTokens, events, tw, parentTraceId, ctx, terminalToolName);
  a.transition('idle');
  safePrune(a, tw, parentTraceId);
  const postPressure = new ContextPressure(ctx, pressureOpts);
  yield* events.send({ type: 'agent:tick', cellsUsed: postPressure.cellsUsed, nCtx: postPressure.nCtx });
}

/**
 * Inline recovery for a single killed agent (trailing stop).
 *
 * Prefills the recovery prompt into the agent's own branch, forces the eager
 * terminal-tool grammar, generates to stop token, extracts the result via
 * `parseChatOutput`, and prunes the branch — all before the tick loop continues.
 * The freed KV lets remaining agents keep researching.
 *
 * Returns true if the agent produced a result.
 */
function* recoverInline(
  agent: Agent,
  policy: AgentPolicy,
  ctx: SessionContext,
  store: BranchStore,
  tw: TraceWriter,
  parentTraceId: number,
  events: EventSender,
  pressureOpts: PressureThresholds,
  terminalGrammar: TerminalGrammar | null,
  terminalToolName: string | undefined,
): Operation<boolean> {
  // Fresh snapshot — the policy uses this to compute the recovery budget
  // (reflected in the rendered prompt via `<%= it.budget %>`).
  const recovery = policy.onRecovery?.(agent, new ContextPressure(ctx, pressureOpts));
  if (!recovery || recovery.type === 'skip') {
    // Skip = policy judged the agent too thin to force a report. `agent:done` already
    // fired at the drop, so emit a terminal event here too — else the agent orphans (no
    // report row ever streams, timer never freezes). Nothing to salvage; fail it cleanly.
    const reason = 'recovery_skipped';
    tw.write({ traceId: tw.nextId(), parentTraceId, ts: performance.now(),
      type: 'pool:recoveryFailed', agentId: agent.id, reason, outputExcerpt: agent.rawOutput.slice(0, 200) });
    yield* events.send({ type: 'agent:failed', agentId: agent.id, reason });
    safePrune(agent, tw, parentTraceId);
    return false;
  }

  const tokens = recoveryPromptTokens(ctx, recovery);

  // Recovery runs in its own scope — if prefill or decode fails (KV
  // exhaustion), the scope tears down cleanly. The recoveryProduce/Return/
  // Failed traces make silent recovery failures observable.
  let reported = false;
  let output = '';
  let producedTokens = 0;
  try {
    yield* scoped(function*() {
      yield* waitUntilSettled(store.prefill([[agent.branch, tokens]]));
      if (terminalGrammar) agent.branch.setGrammar(terminalGrammar);

      tw.write({
        traceId: tw.nextId(), parentTraceId, ts: performance.now(),
        type: 'branch:prefill', branchHandle: agent.id,
        cells: tokens.length, role: 'recovery',
      });

      // Single-agent produce/commit loop
      for (;;) {
        const { token, text, isStop } = agent.branch.produceSync();
        if (isStop) break;
        output += text;
        producedTokens++;
        yield* waitUntilSettled(store.commit([[agent.branch, token]]));
        yield* events.send({ type: 'agent:produce', agentId: agent.id, text, tokenCount: producedTokens });
      }

      reported = yield* finishRecovery(agent, output, producedTokens, events, tw, parentTraceId, ctx, terminalToolName);
    });
  } catch (e) {
    // Scope teardown (KV exhaustion during prefill/decode) — finishRecovery
    // never ran, so emit the failure trace + the terminal UI signal here.
    const reason = `scope_error: ${(e as Error).message ?? 'unknown'}`;
    tw.write({
      traceId: tw.nextId(), parentTraceId, ts: performance.now(),
      type: 'pool:recoveryFailed', agentId: agent.id,
      reason,
      outputExcerpt: output.slice(0, 200),
    });
    // The agent is already shown "writing report" (agent:done fired at the drop);
    // mark it failed so the UI renders a terminal state instead of an eternal spinner.
    yield* events.send({ type: 'agent:failed', agentId: agent.id, reason });
  }

  // Always prune after scope exits (success or failure) — child-safe.
  safePrune(agent, tw, parentTraceId);

  // Emit tick so TUI updates pressure percentage after prune
  const postPressure = new ContextPressure(ctx, pressureOpts);
  yield* events.send({ type: 'agent:tick', cellsUsed: postPressure.cellsUsed, nCtx: postPressure.nCtx });

  return reported;
}

// ── PRODUCE action handlers ─────────────────────────────────────
// Each handler encapsulates state transitions, events, and trace for one
// policy action outcome. The PRODUCE switch dispatches to these.

/**
 * Strip a trailing UNCLOSED `<tool_call>` fragment from text captured as an
 * agent result. When generation is cut mid-tool-call-emission (produce
 * budget, pressure, maxTurns), the parser finds no complete call and the
 * raw tail — `…</think>\n<tool_call><function=read_file>…` with no closing
 * tags — rides into `a.result` verbatim. Any downstream consumer that
 * injects results into another agent's prompt (synth findings, delegation
 * returns) then carries a literal in-context demonstration of emitting tool
 * calls, priming no-tool agents to imitate it (observed:
 * trace-2026-06-11T00-02, agent 65539 → synth rabbit hole).
 *
 * Complete `<tool_call>…</tool_call>` blocks are left alone — they are
 * either parsed before reaching a capture path or deliberate quoting.
 */
function stripDanglingToolCall(text: string): string {
  return text.replace(/<tool_call>(?:(?!<\/tool_call>)[\s\S])*$/, '').trimEnd();
}

/** Trace mirror of the bus `agent:done` — the end of the agent's span. Fires
 *  at the drop or return; recovery events may follow for the same agent.
 *  Always written BEFORE the bus send: the send suspends on subscriber
 *  backpressure (which would inflate the span-end ts), and a cancellation
 *  mid-send must not lose the trace endpoint of an already-recorded drop. */
function traceAgentDone(tw: TraceWriter, parentTraceId: number | null, agentId: number): void {
  tw.write({ traceId: tw.nextId(), parentTraceId, ts: performance.now(), type: 'agent:done', agentId });
}

function* handleFreeTextReturn(
  a: Agent, content: string, events: EventSender,
  tw: TraceWriter, parentTraceId: number | null,
): Operation<void> {
  a.setResult(stripDanglingToolCall(content), 'free_text');
  a.transition('idle');
  traceAgentDone(tw, parentTraceId, a.id);
  yield* events.send({ type: 'agent:return', agentId: a.id, result: a.result! });
  yield* events.send({ type: 'agent:done', agentId: a.id });
}

function* handleIdleDrop(
  a: Agent, reason: IdleReason, events: EventSender,
  tw: TraceWriter, parentTraceId: number,
): Operation<void> {
  a.transition('idle');
  if (reason !== 'free_text_stop') {
    a.exitReason = reason === 'max_turns' ? 'maxTurns' : 'pressure_softcut';
    tw.write({ traceId: tw.nextId(), parentTraceId, ts: performance.now(),
      type: 'pool:agentDrop', agentId: a.id,
      reason: reason === 'max_turns' ? 'maxTurns' : 'pressure_softcut' });
  }
  traceAgentDone(tw, parentTraceId, a.id);
  yield* events.send({ type: 'agent:done', agentId: a.id });
}

function* handleNudge(
  a: Agent, message: string, tc: ParsedToolCall | undefined,
  ctx: SessionContext, tools: Map<string, Tool>,
): Operation<SettledTool> {
  const callId = tc?.id || `call_${a.toolCallCount}`;
  const nudgeResult = { error: message };
  a.incrementTurns();
  a.transition('awaiting_tool');
  const prefillTokens = buildToolResultDelta(ctx, JSON.stringify(nudgeResult), callId, { enableThinking: a.fmt.enableThinking });
  const probe = tools?.get(tc?.name || '')?.probe(nudgeResult) ?? undefined;
  a.resetTurn();
  return { rail: 'token', agentId: a.id, prefillTokens, toolName: tc?.name || '', callId, args: tc?.arguments || '', probe };
}

function* handleReturn(
  a: Agent, result: string, tc: ParsedToolCall, terminalToolName: string,
  pruneOnReturn: boolean, events: EventSender,
  tw: TraceWriter, parentTraceId: number | null,
): Operation<void> {
  a.setResult(stripDanglingToolCall(result), 'voluntary_return');
  a.transition('idle');
  a.incrementToolCalls();
  yield* events.send({ type: 'agent:tool_call', agentId: a.id, tool: terminalToolName, args: tc.arguments });
  traceAgentDone(tw, parentTraceId, a.id);
  yield* events.send({ type: 'agent:return', agentId: a.id, result: a.result! });
  yield* events.send({ type: 'agent:done', agentId: a.id });
  if (pruneOnReturn && !a.branch.disposed) {
    a.harvestMetrics();
    tw.write({ traceId: tw.nextId(), parentTraceId, ts: performance.now(),
      type: 'branch:prune', branchHandle: a.branch.handle, position: a.branch.position });
    a.branch.pruneSync();
  }
}

/**
 * Is the agent already emitting the terminal (report) tool? Then it is producing
 * its OWN report — it must never get a recovery turn bolted on, because that
 * discards the in-flight report and re-prompts it from scratch (the "report
 * resets and restarts" failure). Both kill paths — wind-down and pressure/time —
 * guard on this; the agent is left to finish via the normal `isStop`→return path.
 */
function isEmittingTerminal(agent: Agent, terminalToolName: string | undefined): boolean {
  return terminalToolName != null && agent.currentTool === terminalToolName;
}

/**
 * Parallel recovery (`recoveryShape: 'parallel'`): turn a killed-without-result
 * agent into an in-loop report instead of the blocking `recoverInline`. Mirrors
 * `handleNudge`'s shape — build the recovery turn-delta, park the agent
 * `awaiting_tool`, mark it `extracting`, return a `SettledTool`. SETTLE then
 * re-activates it with the native terminal-tool grammar (the grammar-swap); the
 * report decodes bin-packed in the tick loop, capped at budget `b` by the prompt
 * advisory + the PRODUCE token-stop, which routes the finished/cut report to
 * `finishRecovery`. The caller emits `pool:agentDrop` +
 * `agent:done` first (same order as the `recoverInline` kill path).
 *
 * Returns the `SettledTool` to queue for SETTLE (push onto `nudges`), or `null`
 * after pruning + idling the agent when the policy declines to recover it.
 */
function* handleRecover(
  a: Agent, policy: AgentPolicy, ctx: SessionContext,
  pressureOpts: PressureThresholds, aliveCount: number,
  events: EventSender, tw: TraceWriter, parentTraceId: number,
): Operation<SettledTool | null> {
  // Per-report budget `b`: the prompt advisory (onRecovery's budget arg) and the
  // token-stop backstop share it. Size it so the WHOLE cohort's prefill+decode fits the
  // RECOVERY RESERVE in ONE batched tick — then nothing defers and no findings are lost.
  // Each of the `aliveCount` agents consumes ~its turn prompt (≈RECOVERY_PREFILL_OVERHEAD)
  // + up to `b` report cells, so aliveCount·(OVERHEAD + b) ≤ (remaining − hardLimit) − BATCH_BUFFER
  // ⟹ b ≤ (remaining − hardLimit − BATCH_BUFFER)/aliveCount − OVERHEAD. Sizing against
  // `remaining − hardLimit` (the documented recovery reserve — what the nudge advisory,
  // onSettleReject, and staggered recoverInline all use), NOT `remaining − softLimit`:
  // softLimit is just the model nudge floor, so recovery is allowed to decode the soft
  // reserve down to hardLimit (the SETTLE admission grants the same band). Dividing by the
  // alive count (not just this tick's cohort) reserves room for siblings that could still
  // need recovery. An explicit `policy.reportBudget` is CLAMPED to that ceiling so it can
  // never exceed what fits. Computed here so the prompt's word advisory matches the token-stop.
  const pressure = new ContextPressure(ctx, pressureOpts);
  const fits = Math.floor((pressure.remaining - pressure.hardLimit - BATCH_BUFFER) / Math.max(1, aliveCount)) - RECOVERY_PREFILL_OVERHEAD;
  const b = policy.reportBudget != null
    // Explicit cap: honor the consumer's choice, clamped DOWN so it never exceeds
    // what fits (when there's positive room) — the MIN floor does NOT raise it.
    ? (fits > 0 ? Math.min(policy.reportBudget, fits) : policy.reportBudget)
    // Adaptive: a fair share of headroom across the live agents, clamped to [MIN, MAX].
    : Math.min(MAX_REPORT_BUDGET, Math.max(MIN_REPORT_BUDGET, fits));
  const recovery = policy.onRecovery?.(a, pressure, b);
  if (!recovery || recovery.type === 'skip') {
    // Recovery skipped — the policy judged the agent too thin to force a report
    // (e.g. `DefaultAgentPolicy` skips below its minTokens/minToolCalls floor). But
    // `agent:done` ALREADY fired at the drop, so we MUST still emit a terminal event
    // here — otherwise the consumer orphans the agent (eternal "recovering" state, no
    // report row, timer never freezes). There's nothing to salvage; fail it cleanly.
    const reason = 'recovery_skipped';
    tw.write({ traceId: tw.nextId(), parentTraceId, ts: performance.now(),
      type: 'pool:recoveryFailed', agentId: a.id, reason, outputExcerpt: a.rawOutput.slice(0, 200) });
    yield* events.send({ type: 'agent:failed', agentId: a.id, reason });
    safePrune(a, tw, parentTraceId);
    a.transition('idle');
    return null;
  }
  const prefillTokens = recoveryPromptTokens(ctx, recovery);
  a.incrementTurns();
  if (a.status === 'active') a.transition('awaiting_tool');
  a.markExtracting(b);
  a.resetTurn();
  // Synthetic but identifiable settle identifiers. A recovery turn isn't a real tool
  // call, but blank toolName/callId would emit a blank `tool:settle_order` entry and a
  // blank ToolHistoryEntry; label them so the trace + history are self-describing
  // (callId is unique per agent → keeps any callId-keyed replay oracle deterministic).
  return { rail: 'token', agentId: a.id, prefillTokens, toolName: 'recovery', callId: `recovery:${a.id}`, args: '' };
}

/**
 * Fork an agent from a parent branch with its own system prompt and task.
 *
 * Generator — uses sync native calls so Effection sees everything.
 * On scope exit (error, cancellation), `ensure()` prunes the branch
 * automatically — the orphaned-branch leak is structurally impossible.
 */
function* setupAgent(
  parent: Branch,
  task: AgentTaskSpec,
  ctx: SessionContext,
  enableThinking: boolean,
  clock?: () => number,
): Operation<{ agent: Agent; suffixTokens: number[]; formattedPrompt: string }> {
  // Probe shared-mode. When set, the spine already has the [system + tools]
  // chat header prefilled and we MUST NOT re-emit them in the agent's
  // suffix — the bytes are already in attention via fork prefix-share. The
  // new agent inherits parser/grammar/format/triggers from sharedFmt so
  // tool dispatch keeps working.
  let sharedFmt: FormatConfig | null = null;
  try { sharedFmt = (yield* SpineFmt.get()) ?? null; } catch { /* not in shared mode */ }

  // Compose the messages to format into the suffix. In shared mode with
  // an empty per-spec systemPrompt, drop the system message — the role
  // lives at the spine, the agent only contributes a user turn. With a
  // non-empty per-spec systemPrompt, include it: the agent's KV will
  // contain TWO system messages in lineage, which Qwen3 handles (recovery
  // ships on the same multi-system pattern).
  const messages = sharedFmt && task.systemPrompt === ''
    ? [{ role: 'user', content: task.content }]
    : [
        { role: 'system', content: task.systemPrompt },
        { role: 'user', content: task.content },
      ];

  const fmtOpts: Record<string, unknown> = { enableThinking };
  // Tools belong at the spine in shared mode; emitting them again here
  // would re-prefill the same schema bytes for nothing.
  if (task.tools && !sharedFmt) fmtOpts.tools = task.tools;
  const fmt = ctx.formatChatSync(JSON.stringify(messages), fmtOpts);
  // Tool-support guard runs only on the non-shared path. Shared mode's
  // spine already passed the equivalent check at withSpine setup.
  if (task.tools && !sharedFmt
      && (fmt.format === CHAT_FORMAT_CONTENT_ONLY || fmt.format === CHAT_FORMAT_GENERIC)) {
    // Error before fork — no branch to clean up
    throw new Error('Model does not support tool calling. Please use a model with native tool support (e.g. Qwen3, Llama 3.x, Mistral).');
  }
  const branch = parent.forkSync();
  const sep = ctx.getTurnSeparator();
  const suffixTokens = [...sep, ...ctx.tokenizeSync(fmt.prompt, false)];
  if (task.seed != null) branch.reseedSampler(task.seed);

  // Read calling agent from Effection context (set during outer pool's DISPATCH)
  let callingAgent: Agent | null = null;
  try { const a = yield* CallingAgent.get(); if (a) callingAgent = a; } catch { /* top-level — no caller */ }

  // The spawn's ability membership is now a non-enforcing label:
  // the authGuard gates tools by `Tool.protected` + session grants at the
  // pool level, not by ability-scoped allow-lists. The label is carried for
  // trace attribution (`tool:authReject`) and harness UI only.
  const assignedAbility: string | null = task.assignedAbility ?? null;

  // In shared mode the new agent's parser/grammar/format/triggers come
  // from the spine's pre-computed fmt — those fields know about the tool
  // set that's in attention via the inherited prefix. In non-shared
  // mode, fresh fmt drives those fields (existing behavior).
  const fmtConfig: FormatConfig = sharedFmt
    ? {
        format: sharedFmt.format,
        reasoningFormat: sharedFmt.reasoningFormat,
        generationPrompt: sharedFmt.generationPrompt,
        parser: sharedFmt.parser,
        grammar: sharedFmt.grammar,
        grammarLazy: sharedFmt.grammarLazy,
        grammarTriggers: sharedFmt.grammarTriggers,
        enableThinking,
      }
    : {
        format: fmt.format,
        reasoningFormat: fmt.reasoningFormat,
        generationPrompt: fmt.generationPrompt,
        parser: fmt.parser,
        grammar: fmt.grammar,
        grammarLazy: fmt.grammarLazy,
        grammarTriggers: fmt.grammarTriggers,
        enableThinking,
      };

  const agent = new Agent({
    id: branch.handle,
    parentId: parent.handle,
    branch,
    parent: callingAgent,
    task: task.content,
    fmt: fmtConfig,
    assignedAbility,
    clock,
  });

  return { agent, suffixTokens, formattedPrompt: fmt.prompt };
}

/**
 * Concurrent agent generation loop as an Effection resource
 *
 * Runs N agents in parallel using a phased tick loop over shared
 * {@link BranchStore} infrastructure. Each agent forks from a parent
 * branch, generates tokens, invokes tools, and reports findings.
 *
 * **Tick loop (per tick):** SPAWN+EXTEND (drain queued spawns/extends +
 * pending cancels) → PRODUCE (sample all active agents via `produceSync()`,
 * no async gap) → COMMIT (single `store.commit()` for all produced tokens) →
 * DRAIN (post-process completed fan-out tool results) → SETTLE (drain settled
 * tool results, batch prefill, reset grammars) → DISPATCH (execute collected
 * tool calls).
 *
 * **Dispatch is per-agent serial, inter-agent concurrent.** Each agent has at
 * most one tool in flight — PRODUCE emits one call, then parks the agent
 * `awaiting_tool` until its result settles (the barrier that yields the
 * decision boundary). Inline tools run on this loop fiber, so `llama_context`
 * access is exclusive by single-fiber discipline. A `Tool.fanout` tool runs
 * OFF the loop fiber (bounded by a permit gate), issues no main-context op,
 * and has its result tokenized/prefilled later in DRAIN + SETTLE on the loop
 * fiber — so the store is only ever touched from the tick loop, never
 * concurrently.
 *
 * **Resource semantics:** `provide()` suspends after all agents complete,
 * keeping branches alive so the caller can fork from them (e.g. for
 * verification). Branches are pruned when the scope exits — each branch's
 * `ensure()` from `setupAgent` handles cleanup automatically.
 *
 * For automatic branch cleanup on return, use {@link runAgents} instead.
 *
 * @param opts - Pool configuration: tasks, tools, sampling params, max turns
 * @returns Agent pool result with per-agent findings and aggregate statistics
 *
 * @example Spine with agent pool
 * ```typescript
 * const pool = yield* withSpine(
 *   { systemPrompt: RESEARCH_PROMPT, tools: toolsJson },
 *   function*(spine) {
 *     return yield* useAgentPool({
 *       tasks: questions.map(q => ({
 *         systemPrompt: RESEARCH_PROMPT,
 *         content: q,
 *         tools: toolsJson,
 *         parent: spine,
 *       })),
 *       tools: toolMap,
 *       maxTurns: 6,
 *     });
 *   },
 * );
 * ```
 *
 * @category Agents
 */
export function useAgentPool(opts: AgentPoolOptions): Operation<Subscription<AgentEvent, AgentPoolResult>> {
  return resource(function*(provide) {
    const ctx: SessionContext = yield* Ctx.expect();
    const store: BranchStore = yield* Store.expect();
    const poolChannel = createChannel<AgentEvent, AgentPoolResult>();

    // Bridge for onProgress callbacks — Signal is correct here (external callback).
    // A spawned forwarder drains the bridge into the poolChannel with proper scope context.
    const progressBridge = createSignal<AgentEvent, void>();
    yield* spawn(function*() {
      for (const ev of yield* each(progressBridge)) {
        yield* poolChannel.send(ev);
        yield* each.next();
      }
    });
    const tw = yield* Trace.expect();
    // The run's image sink — a tool result's pictures are recorded here for
    // the same reason the other two ingresses record theirs: the trace keeps
    // the marker, this keeps what it stood for.
    const attachments = yield* Attachments.expect();
    const ingress = yield* Ingress.expect();
    // ── Dispatch attribution ────────────────────────────────────
    // dispatch() sets a per-dispatch tee as the Trace context for the tool's
    // execution, stamping the dispatching agent + call INTO the event data:
    // `agentId`, `callId`, and a real `parentTraceId` replacing the
    // abilities' hardcoded null. Attribution lives in the record itself, so
    // every sink reads the same fields — the file, and the dev pane via the
    // writer-boundary mirror (rig's `useTraceWriter`). That mirror is where
    // the bus tee moved: ONE mirror at the boundary every write crosses,
    // instead of per-layer mirrors with per-layer allowlists (session-level
    // writes like the trunk's `warmDelta` never reached the old pool tee).
    // Only-if-absent semantics keep a nested pool's (DelegateTool) inner
    // attribution intact: its tee stamps first, this one defers.
    const toolTee = (agentId: number, callId: string, dispatchTraceId: number): TraceWriter => ({
      nextId: () => tw.nextId(),
      flush: () => tw.flush(),
      write: (event: TraceEvent) => tw.write({
        ...event,
        agentId: event.agentId ?? agentId,
        callId: event.callId ?? callId,
        parentTraceId: event.parentTraceId ?? dispatchTraceId,
      }),
    });
    const { spine, orchestrate, toolsJson, tools, maxTurns = 100, terminalToolName, trace = false, pruneOnReturn = false, enableThinking = true, eagerGrammar } = opts;

    // Tool index map for trace — position in toolkit array
    const toolIndexMap = new Map([...tools.keys()].map((name, i) => [name, i]));
    const toolkitSize = tools.size;

    const poolT0 = performance.now();
    let poolParentTraceId: number | null = null;
    try { const p = yield* TraceParent.get(); if (p != null) poolParentTraceId = p; } catch { /* top level */ }
    // Optional graceful wind-down signal: the consumer `.send()`s it (e.g. a
    // "Wrap up" command) to drain the pool to a fast best-effort answer — stop
    // spawning, reap active agents, let in-flight tools settle, then fold. Absent
    // ⇒ no wind-down (today's behaviour). See the WindDown context.
    let windDownSignal: Signal<void, void> | null = null;
    try { windDownSignal = (yield* WindDown.get()) ?? null; } catch { /* no wind-down provided */ }
    // Optional per-agent cancel signal: the consumer `.send({agentId})`s it (e.g. a
    // per-card ×) to discard ONE live agent — halt its in-flight tool, emit a terminal
    // agent:failed (user_cancel), prune its branch to reclaim KV. Absent ⇒ no cancel.
    let cancelSignal: Signal<{ agentId: number }, void> | null = null;
    try { cancelSignal = (yield* CancelAgent.get()) ?? null; } catch { /* no cancel provided */ }
    // Optional pause signal: while true the tick loop HOLDS at the tick
    // boundary. See the Pause context. Absent ⇒ no pause capability.
    let pauseSignal: Signal<boolean, void> | null = null;
    try { pauseSignal = (yield* Pause.get()) ?? null; } catch { /* no pause provided */ }
    const poolScopeId = yield* useTraceScope(tw, poolParentTraceId, 'pool', { maxTurns, terminalToolName });

    // Whether the pool's tool registry contains tools besides the terminal tool.
    // When false, agents are allowed to call the terminal tool as their first
    // action (e.g. reporter sub-agents that only have `report()`). When true,
    // the first tool call must be a non-terminal tool to prevent agents from
    // immediately reporting without doing any work.
    //
    // IMPORTANT: this checks the pool's `tools` registry, not individual task
    // schemas (`task.tools`). A reporter pool must pass only the terminal tool
    // in its registry — passing the full tool map makes this flag true and
    // traps reporters in an infinite rejection loop.
    const hasNonTerminalTools = terminalToolName ? [...tools.keys()].some(k => k !== terminalToolName) : tools.size > 0;

    // The eager terminal-tool grammar that forces a recovered agent to emit a
    // schema-valid terminal call (whatever the harness designated as terminal).
    // Computed once from the terminal tool's schema; `null` when there is no terminal
    // tool — recovery still runs, but with no grammar to force a schema-valid call the
    // agent decodes unconstrained and `finishRecovery` extracts via `parseChatOutput`
    // (or emits `agent:failed` when no call is parseable). It does NOT no-op.
    const terminalTool = terminalToolName ? tools.get(terminalToolName) : undefined;
    const terminalGrammar = terminalTool ? buildTerminalGrammar(ctx, terminalTool) : null;
    const policy = opts.policy ?? new DefaultAgentPolicy();
    // ── Pause state: two values and a pure function ──────────────────
    // `paused` is fed by the watcher below; `pausedTotal` accumulates inside
    // the hold. The run clock derives from them — policy time budgets and
    // agent.startedAt stamps measure RUN time, never a pause. Retry parks
    // and trace `ts` stay on the wall clock (external-world time).
    let paused = false;
    let pausedTotal = 0;
    const runNow = (): number => performance.now() - pausedTotal;
    policy.bindClock?.(runNow);
    const pressureOpts: PressureThresholds = policy.pressureThresholds
      ?? { softLimit: ContextPressure.DEFAULT_SOFT_LIMIT, hardLimit: ContextPressure.DEFAULT_HARD_LIMIT };

    // Invariant: hardLimit must be at least the native batch size (nBatch).
    // When `pressure.critical` fires and the kill path runs recovery, the
    // reserve cells (hardLimit count) must accommodate `recoverInline`'s
    // next batch allocation — otherwise native decode will OOM with
    // "failed to find a memory slot for batch of size N".
    // Until `SessionContext.nBatch` is exposed natively, we validate against
    // `ContextPressure.ASSUMED_N_BATCH` (512, matches llama.cpp default).
    const nBatch = ContextPressure.ASSUMED_N_BATCH;
    const hardLimitVal = pressureOpts.hardLimit ?? ContextPressure.DEFAULT_HARD_LIMIT;
    if (hardLimitVal < nBatch) {
      throw new Error(
        `useAgentPool: Invariant Violation — hardLimit (${hardLimitVal}) must be >= nBatch (${nBatch}). ` +
        `Recovery reserves hardLimit cells for its own decode; if smaller than nBatch, the next batch ` +
        `allocation will OOM. Increase policy.budget.context.hardLimit to at least ${nBatch}.`
      );
    }

    // authGuard inputs, resolved once per pool:
    //   • protectedTools — names this pool's registry flags `Tool.protected`.
    //   • grants — protected names the session is authorized to call, read
    //     from GrantStoreCtx. Absent store = fail-closed (no grants).
    // When nothing is protected (the common case) the authGuard never fires.
    const protectedTools = new Set(
      [...tools].filter(([, t]) => t.protected).map(([name]) => name),
    );
    let grants: ReadonlySet<string> = new Set();
    if (protectedTools.size > 0) {
      try {
        const grantStore = yield* GrantStoreCtx.expect();
        grants = new Set(yield* grantStore.granted());
      } catch { /* no grant store on context — fail-closed (no grants) */ }
    }
    const policyConfig: PolicyConfig = {
      maxTurns, terminalToolName, hasNonTerminalTools, protectedTools, grants,
    };

    // ── Orchestrator-driven setup ────────────────────────────
    // Agents are spawned lazily via `ctx.spawn` from the orchestrator.
    // The tick loop iterates over whatever agents are currently active.
    // decode_each batches across all active agents regardless of spawn order.
    const agents: Agent[] = [];
    const agentById = new Map<number, Agent>();

    // Pending spawns — populated by PoolContext.spawn, drained by the tick
    // loop's SPAWN phase. Queuing here lets multiple orchestrator-issued
    // spawns batch into ONE store.prefill call (continuous tree batching),
    // and guarantees that all native store operations are issued from the
    // tick loop's single fiber — never concurrently with other store work.
    interface PendingSpawn {
      agent: Agent;
      suffixTokens: number[];
      formattedPrompt: string;
      task: AgentTaskSpec;
    }
    const pendingSpawns: PendingSpawn[] = [];

    // Pending extends — populated by PoolContext.extendSpine, drained in the
    // same SPAWN phase as pendingSpawns so extend-onto-spine and fork-suffix
    // prefills batch into one native store.prefill call. Cross-fiber
    // rendezvous uses action(): each extendSpine call suspends on its own
    // resolve/reject closure, which the drain resolves after prefill lands.
    // Fixes the pre-fix race where extendSpine called store.prefill directly
    // from the orchestrator fiber, concurrently with the tick loop's native
    // work (same class of bug that 50a0baf fixed for spawn).
    interface PendingExtend {
      tokens: number[];
      userContent: string;
      assistantContent: string;
      resolve: (deltaTokens: number) => void;
      reject: (err: Error) => void;
      discarded: boolean;
    }
    const pendingExtends: PendingExtend[] = [];

    // Pending cancels — agentIds enqueued by the CancelAgent watcher, drained on the
    // loop fiber before PRODUCE (a stable point: spawns settled, no decode in flight).
    // Single-fiber discipline: the halt + prune runs on the tick, never from the
    // watcher fiber, so it can't race the tick's native store work.
    const pendingCancels: number[] = [];

    // Agents that have received a TERMINAL `agent:failed` and are fully
    // DISCARDED. Downstream phases must never resurrect one: the termination
    // sweep must not force-recover it (its branch may still be alive —
    // `safePrune` is a documented no-op on a branch with live children), and
    // DRAIN must not emit tool events for a completion that lands afterwards.
    //
    // TWO paths write it, and only one used to. A user cancel
    // (`drainCancels`) and a poisoned media prefill (SETTLE) do the identical
    // three things at the point of discard — terminal `agent:failed`,
    // `safePrune`, `transition('idle')` — but only the cancel was remembered
    // past the tick, so a poisoned agent still satisfied every condition the
    // sweep tests and was recovered on a branch the runtime had just called
    // unresumable. The observable symptom was TWO terminal events for one
    // agent: `media_prefill_failed`, then `recovery_skipped`.
    //
    // NOT the same set as SETTLE's local `poisoned`, which answers a different
    // question — "did this agent's prefill land in THIS tick?" — and is used
    // to skip re-activation. One fact needs one name; two facts keep two.
    const discardedIds = new Set<number>();

    // ── Self-healing ladder state (docs/self-healing.md) ──
    /** rc==1 deferrals per agent; cleared when a settle lands. */
    const deferAttempts = new Map<number, number>();
    /** Consecutive fatal rcs across dispatches; reset by any success. */
    let consecutiveFatalRc = 0;
    /** Set at BACKEND_TRIPWIRE_N — the ladder stops, failures go terminal. */
    let backendSuspect = false;
    /** Per-agent KV-delta record since spawn — heal's replay material. One
     *  shape, two sinks: every piece is ALREADY on the trace (agent:turn's
     *  rawOutput, tool:result, branch:prefill's probeText); this holds the
     *  same data where heal can read it back same-process. */
    const turnRecordsById = new Map<number, AgentTurnRecord[]>();
    const recordFor = (id: number): AgentTurnRecord[] => {
      let r = turnRecordsById.get(id);
      if (!r) { r = []; turnRecordsById.set(id, r); }
      return r;
    };
    /** The birth certificate — what a heal reproduces (seed, tools, ability,
     *  the spec's exact text). Recorded at the SPAWN drain. */
    const specById = new Map<number, AgentTaskSpec>();
    /** Heal count per lineage (a replacement inherits its original's + 1). */
    const healAttemptOf = new Map<number, number>();
    const pendingHeals: {
      spec: AgentTaskSpec; records: AgentTurnRecord[];
      of: number; rc?: number; attempt: number;
    }[] = [];

    // Pool-level branch cleanup — ensures orphan-branch cleanup even when
    // spawns are lazy and the orchestrator's spawn scope exits early.
    //
    // `safePrune`, not `pruneSync` and not `pruneSubtreeSync`.
    //
    // `pruneSync()` (the original) throws on a branch with live children —
    // inside an `ensure()`, where a throw unwinds teardown and can mask
    // whatever the run was already failing on. That is the real defect here.
    //
    // `pruneSubtreeSync()` (what briefly replaced it) is not a memory bug —
    // the kernel is generation-checked, so freeing a stale handle is inert —
    // but it is still the wrong tool: it frees OTHER AGENTS' branches as a
    // side effect while leaving their `Branch` objects reading
    // `disposed === false`, so every later reader of those objects is working
    // from a flag that lies. It is right in `spine.ts` / `use-agent.ts`, where
    // the branch owns its subtree and no sibling object aliases a descendant.
    //
    // `safePrune` does neither: it asks the CONTEXT whether children are live
    // (disposed-filtered, so a freed child stops counting) and lets each
    // branch set its own flag. REVERSED, so children are reached before their
    // parents — agents are spawned parent-first, so a parent can become
    // prunable in the same pass. Whatever this cannot free is freed when the
    // context itself goes.
    yield* ensure(() => {
      for (let i = agents.length - 1; i >= 0; i--) {
        safePrune(agents[i], tw, poolScopeId);
      }
    });

    // Lazy grammar setup — applied inside ctx.spawn after prefill completes.
    const applyLazyGrammar = (a: Agent): void => {
      // Eager grammar (schema-based agents like the planner) takes priority
      // over lazy tool-call grammar. Qwen3.5's chat template emits a lazy
      // tool-call grammar even when no tools are passed (a non-empty
      // fmt.grammar with a `<tool_call>` trigger), which would otherwise
      // overwrite a schema grammar set elsewhere — the planner would still
      // be unconstrained. With eager set, we use the strict schema grammar
      // and skip the (no-tools-anyway) lazy trigger.
      if (eagerGrammar) {
        a.branch.setGrammar(eagerGrammar);
      } else if (tools.size > 0 && a.fmt.grammar && a.fmt.grammarLazy && a.fmt.grammarTriggers.length > 0) {
        // tools.size guard: with an empty toolkit there is nothing to
        // dispatch, but the template still emits a tool-call grammar (see
        // above). Installing it would not BLOCK the `<tool_call>` trigger —
        // lazy grammars activate on the trigger, they don't prevent it —
        // but once triggered it FORCES syntactic completion of a full call
        // the model may have sampled into by accident. A no-tool agent
        // (synth, eval) must be free to wander back to prose instead.
        const triggers = a.fmt.grammarTriggers.map(t => {
          if (t.type === GrammarTriggerType.WORD) {
            const nlIdx = t.value.indexOf('\n');
            if (nlIdx >= 0 && nlIdx < t.value.length - 1) {
              return { ...t, value: t.value.slice(0, nlIdx + 1) };
            }
          }
          return t;
        });
        a.branch.setGrammarLazy(a.fmt.grammar, triggers);
      }
    };

    tw.write({
      traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
      type: 'pool:open', agentCount: 0, taskSuffixTokens: [],
      pressure: (() => {
        const p = new ContextPressure(ctx, pressureOpts);
        return { remaining: finiteOrNull(p.remaining), softLimit: p.softLimit, headroom: finiteOrNull(p.headroom) };
      })(),
    });

    // ── PoolContext — orchestrator's API surface ─────────────
    const poolContext: import('./orchestrators').PoolContext = {
      spine,

      *spawn(spec) {
        const parent = spec.parent ?? spine;
        const task: AgentTaskSpec = {
          systemPrompt: spec.systemPrompt,
          content: spec.content,
          tools: toolsJson,
          seed: spec.seed,
          ...(spec.after && spec.after.length > 0 ? { after: spec.after } : {}),
          parent,
          assignedAbility: spec.assignedAbility,
        };

        // Synchronous setup — fork, tokenize suffix, pressure check.
        // No native store call yet; that's the tick loop's SPAWN phase's job.
        const { agent, suffixTokens, formattedPrompt } = yield* setupAgent(parent, task, ctx, enableThinking, runNow);

        const pressure = new ContextPressure(ctx, pressureOpts);
        // Reserve for batch-mates: spawns/extends admitted earlier this tick
        // haven't prefilled yet, so raw pressure doesn't see them. Without
        // the reservation, N individually-valid spawns cram N suffixes into
        // one SPAWN-phase prefill and every agent dies pressure_softcut on
        // turn 0 (trace-2026-06-11T06-21: 6 × 4,819-token suffixes vs 32k).
        const reserved =
          pendingSpawns.reduce((acc, ps) => acc + ps.suffixTokens.length, 0) +
          pendingExtends.reduce((acc, pe) => acc + (pe.discarded ? 0 : pe.tokens.length), 0);
        if (!pressure.canFit(reserved + suffixTokens.length)) {
          agent.branch.pruneSync();
          agent.dispose();
          tw.write({
            traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
            type: 'pool:agentDrop', agentId: agent.id, reason: 'pressure_init',
          });
          throw new Error(`useAgentPool: cannot fit agent suffix (${suffixTokens.length} tokens) under current pressure`);
        }

        // Enqueue for SPAWN phase. The tick loop will batch this with any
        // other pending spawns into ONE store.prefill, transition to active,
        // write trace events, and emit agent:spawn. Return the agent
        // immediately — waitFor() is keyed off a transition, not a status
        // snapshot, so the pre-activation 'idle' status doesn't race with
        // the real terminal-idle signal.
        pendingSpawns.push({ agent, suffixTokens, formattedPrompt, task });
        agents.push(agent);
        agentById.set(agent.id, agent);

        return agent;
      },

      *waitFor(agent) {
        // Agent completion = terminal 'idle' OR 'disposed'. Pre-activation
        // 'idle' (the constructor default) would be a false positive, so we
        // wait for a TRANSITION signal rather than checking status.snapshot.
        // The SPAWN phase transitions 'idle' → 'active' when it activates the
        // agent; subsequent transitions lead to a terminal 'idle' or 'disposed'.
        const stream = yield* each(agent.statusSignal);
        // Only short-circuit for already-disposed — no further signal is coming.
        if (agent.status === 'disposed') return agent;
        for (const s of stream) {
          if (s === 'idle' || s === 'disposed') return agent;
          yield* each.next();
        }
        return agent;
      },

      *extendSpine(userContent, assistantContent) {
        if (!assistantContent) return 0;
        const turnTokens = buildTurnDelta(ctx, userContent, assistantContent);
        // Rendezvous with the tick loop's SPAWN phase — see pendingExtends.
        // action() is the Effection-native one-shot suspend: orchestrator
        // queues the request, suspends; tick loop drains + resolves; this
        // operation returns the deltaTokens. The finally returned from the
        // executor marks the request discarded if this fiber is cancelled
        // before the drain runs, so the drain doesn't touch a dead action.
        return yield* action<number>((resolve, reject) => {
          const req: PendingExtend = {
            tokens: turnTokens,
            userContent,
            assistantContent,
            resolve,
            reject,
            discarded: false,
          };
          pendingExtends.push(req);
          return () => { req.discarded = true; };
        });
      },

      canFit(estimatedSuffixTokens) {
        return new ContextPressure(ctx, pressureOpts).canFit(estimatedSuffixTokens);
      },
    };

    // Subscribe BEFORE spawning orchestrator or tick loop — no events missed
    const subscription = yield* poolChannel;

    // Orchestrator runs concurrently with tick loop under the pool scope.
    // Sets orchestratorDone when complete; tick loop terminates on
    // (orchestratorDone && all agents idle/disposed).
    let orchestratorDone = false;
    let orchestratorError: unknown = null;
    const orchestratorTask = yield* spawn(function*() {
      try {
        yield* orchestrate(poolContext);
      } catch (e) {
        orchestratorError = e;
      } finally {
        orchestratorDone = true;
      }
    });

    // Spawn tick loop — runs concurrently with Subscription consumption.
    // scoped() creates an error boundary: if llama_decode fails (KV exhaustion),
    // the scope tears down and the channel closes with whatever results exist.
    yield* spawn(function*() {
    let steps = 0;
    let totalToolCalls = 0;
    const counters = { warmPrefillCalls: 0, warmPrefillBranches: 0 };

      try {

    // ── Phase operations (close over pool scope) ────────────

    /** SETTLE: prefill tool results that fit, defer oversized items for next tick */
    function* settle(items: SettledTool[]): Operation<SettledTool[]> {
      const settlePressure = new ContextPressure(ctx, pressureOpts);
      let headroom = settlePressure.headroom;
      // Recovery (extracting) items may spend the softLimit reserve DOWN TO hardLimit —
      // the documented recovery reserve (agent-pool.ts ContextPressure docstring; same
      // floor the nudge advisory + staggered recoverInline already use). So an extracting
      // item's admission budget is `headroom + reserveBand` (= remaining − hardLimit);
      // plain tool-result (new research) items stay gated at `headroom` (preserve softLimit).
      const reserveBand = settlePressure.softLimit - settlePressure.hardLimit;

      // The two admitted-item lists. Each entry carries what its `branch:prefill`
      // will need, because that event is written AFTER the dispatch it describes
      // — it asserts the KV moved, and on the media rail an entry can fail.
      const tokenItems: { agent: Agent; tokens: number[]; cells: number; src: SettledTool }[] = [];
      // Media rides its own list: `llama_batch` is token-XOR-embd, so these
      // cannot join the token batch — a separate call, not a separate strategy.
      const mediaItems: {
        agent: Agent; delta: MultimodalDelta; cells: number;
        attachments?: readonly Attachment[]; src: SettledTool;
      }[] = [];

      /** One `branch:prefill` for an entry that LANDED. Never called for a
       *  deferred or poisoned one: nothing moved for those. */
      const writePrefilled = (
        a: Agent, cells: number, refs?: readonly Attachment[],
      ): void => {
        tw.write({ traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
          type: 'branch:prefill', branchHandle: a.id,
          cells, role: 'toolResult', ...(refs ? { attachments: refs } : {}) });
      };
      const settledAgents: Agent[] = [];
      const settledOrder: { agentId: number; callId: string; cells: number }[] = [];
      const itemProbes = new Map<number, string | undefined>();
      const deferred: SettledTool[] = [];
      const poisoned = new Set<number>();

      /** Success-only bookkeeping, run AFTER a dispatch landed — the same
       *  discipline `writePrefilled` already follows. Nothing here runs for
       *  a deferred or failed entry, so the trace, the tool history and the
       *  re-activation list all describe only what actually happened. */
      const bookSettled = (
        a: Agent, src: SettledTool, cells: number, refs?: readonly Attachment[],
        resultStrOverride?: string,
      ): void => {
        const resultStr = resultStrOverride ?? src.resultStr;
        if (resultStr) {
          recordFor(a.id).push({
            kind: 'toolResult', resultStr, callId: src.callId,
            ...(refs && refs.length > 0 ? { attachments: refs } : {}),
          });
        }
        settledAgents.push(a);
        settledOrder.push({ agentId: a.id, callId: src.callId, cells });
        if (src.probe) itemProbes.set(a.id, src.probe);
        deferAttempts.delete(a.id);
        const postSettle = new ContextPressure(ctx, pressureOpts);
        a.recordToolResult({
          name: src.toolName, args: src.args,
          resultCells: cells,
          contextAfterPercent: postSettle.percentAvailable,
          timestamp: performance.now(),
        });
        writePrefilled(a, cells, refs);
      };

      /** rc==1: no KV slot, state restored — the branch is INTACT. The item
       *  re-enters via the deferral stream (`pendingSettled` next tick). */
      const writeDeferred = (a: Agent, rc: number, attempt: number): void => {
        const p = new ContextPressure(ctx, pressureOpts);
        tw.write({ traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
          type: 'pool:agentDefer', agentId: a.id, rc, attempt,
          pressure: { remaining: finiteOrNull(p.remaining), cellsUsed: p.cellsUsed,
            nCtx: p.nCtx, headroom: finiteOrNull(p.headroom) } });
      };

      /** The terminal path — the ladder's bottom rung. Prune-and-discard is
       *  safe whatever the rc said: pruning an intact branch is harmless,
       *  and a poisoned one must never be resumed. */
      function* failSettled(
        a: Agent,
        reason: 'media_prefill_failed' | 'tool_result_failed',
        detail: string,
        rc?: number,
      ): Operation<void> {
        poisoned.add(a.id);      // skip re-activation THIS tick
        discardedIds.add(a.id);  // and never resurrect it in any later one
        tw.write({ traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
          type: 'pool:settleFailed', agentId: a.id, reason,
          detail: detail.slice(0, 200), ...(rc !== undefined ? { rc } : {}) });
        yield* poolChannel.send({ type: 'agent:failed', agentId: a.id, reason });
        safePrune(a, tw, poolScopeId);
        a.transition('idle');
      }

      for (const item of items) {
        const a = agentById.get(item.agentId);
        if (!a || a.status === 'idle') continue;

        // Admission cost. A recovery item (the agent is `extracting`) reserves the
        // REPORT room too (prompt + b) — it will decode up to `recoveryBudget` tokens
        // AFTER this prefill — and is budgeted against `remaining − hardLimit`
        // (`headroom + reserveBand`), i.e. it may consume the softLimit reserve down to
        // the hardLimit floor (the documented recovery reserve). `b` is sized in
        // handleRecover so aliveCount·(prompt + b) ≤ remaining − hardLimit, so this gate
        // ADMITS ALL N in the normal case: no wave, no defer (decode is O(1) in branch
        // count, they batch in one tick). It bites ONLY when KV is genuinely too tight
        // (`b` floored at MIN, (prompt + b)·N > remaining − hardLimit): the overflow
        // defers → stall-break → serial `recoverInline` (uncapped, prune-between,
        // lossless), never a report-decode overflow. Plain tool-result items reserve
        // only their prompt and stay gated at `headroom` (preserve the softLimit reserve).
        // A media item's cost is the MEASURED cell count, not a token length:
        // its `prefillTokens` is empty because mtmd tokenizes downstream.
        const itemCells = settledCells(item);
        const cost = a.extracting ? itemCells + a.recoveryBudget : itemCells;
        const budget = a.extracting ? headroom + reserveBand : headroom;
        if (cost > budget) {
          // Defer — siblings may finish and free KV, letting this result
          // settle next tick (staggered-exit for parallel orchestration).
          // Policy is consulted at stall-break time, not here: invoking
          // it eagerly would break "wait for a sibling to report and
          // free cells" by nudging/dropping on first over-headroom.
          deferred.push(item);
          continue;
        }

        // Committed by the barrier at the delta-build seam; nothing is stored
        // here. A tick's worth of orphan is fine — SETTLE may DEFER this item
        // for headroom, so a manifest can exist before its prefill lands.
        if (item.rail === 'media') {
          mediaItems.push({
            agent: a, delta: item.media.delta, cells: itemCells,
            attachments: item.media.attachments, src: item,
          });
        } else {
          tokenItems.push({ agent: a, tokens: item.prefillTokens, cells: itemCells, src: item });
        }
        // Admission only RESERVES here; the bookkeeping (settle order, tool
        // history, re-activation list, branch:prefill) runs after the
        // dispatch lands — success-only, like the events it feeds.
        headroom -= cost;
      }

      if (tokenItems.length > 0) {
        try {
          yield* waitUntilSettled(store.prefill(
            tokenItems.map(t => [t.agent.branch, t.tokens] as [Branch, number[]])));
          counters.warmPrefillCalls++;
          counters.warmPrefillBranches += tokenItems.length;
          consecutiveFatalRc = 0;
          for (const t of tokenItems) bookSettled(t.agent, t.src, t.cells);
        } catch (err) {
          const de = decodeErrorOf(err);
          const rc = de?.rc;
          if (rc === 1 && de?.partial && !backendSuspect) {
            // No KV slot for a LATER chunk: the chunks before it landed and
            // moved their branches' books, and the error does not say which.
            // Re-queuing the cohort whole would decode the landed ones twice
            // onto advanced positions, so the cohort takes the per-agent
            // terminal instead — the kernel's rule: intact ⇔ the failing call
            // restored state (rc 1 or -1) and nothing before it landed.
            for (const t of tokenItems) {
              yield* failSettled(t.agent, 'tool_result_failed',
                `partial prefill: ${err instanceof Error ? err.message : String(err)}`, rc);
            }
          } else if (rc === 1 && !backendSuspect) {
            // No KV slot for the batch; state restored — every branch is
            // INTACT. Re-queue the items whole: a sibling finishing frees
            // cells and they settle on a later tick. This used to take the
            // entire pool down.
            for (const t of tokenItems) {
              const attempt = (deferAttempts.get(t.agent.id) ?? 0) + 1;
              deferAttempts.set(t.agent.id, attempt);
              if (attempt > MAX_DEFER_ATTEMPTS) {
                yield* failSettled(t.agent, 'tool_result_failed',
                  `deferral exhausted after ${MAX_DEFER_ATTEMPTS} attempts: ${err instanceof Error ? err.message : String(err)}`, rc);
              } else {
                writeDeferred(t.agent, rc, attempt);
                deferred.push(t.src);
              }
            }
          } else {
            // Fatal (2 / < -1), rc-less, or the tripwire is up: today's
            // behavior — the tick throws and the pool scope tears down —
            // now with the rc preserved on the error for the postmortem.
            if (rc === 2 || (rc !== undefined && rc < -1)) consecutiveFatalRc++;
            throw err;
          }
        }
      }

      // The third dispatch. Media cannot share the token batch, so it goes as
      // one cohort call in the same position and style as the two around it —
      // how many dispatches (and vision-tower encodes) that costs stays the
      // native worker's business, so making it cheaper later touches no JS.
      //
      // Per-item outcomes, not a rejected promise: one agent's failure must
      // not cost its siblings their prefills. Each entry classifies by the
      // rc and partial flag the worker attached (docs/self-healing.md): 1 and
      // -1 restored the failing call, so the branch is INTACT unless `partial`
      // says an earlier chunk landed; 2 / < -1 poison it (decode_segments is
      // not atomic, and partial-range KV ops are meaningless on recurrent
      // layers). Anything not intact is pruned, never resumed.
      if (mediaItems.length > 0) {
        const results = yield* waitUntilSettled(
          store.prefillMultimodal(mediaItems.map(m => [m.agent.branch, m.delta] as [Branch, MultimodalDelta])));
        counters.warmPrefillCalls++;
        counters.warmPrefillBranches += mediaItems.length;
        for (let i = 0; i < mediaItems.length; i++) {
          const m = mediaItems[i];
          const r = results[i];
          if (!r?.error) {
            consecutiveFatalRc = 0;
            bookSettled(m.agent, m.src, m.cells, m.attachments);
            continue;
          }
          const a = m.agent;
          const rc = r.rc;

          if (rc === 1 && !r.partial && !backendSuspect) {
            // Intact — re-queue for a later tick, budgeted.
            const attempt = (deferAttempts.get(a.id) ?? 0) + 1;
            deferAttempts.set(a.id, attempt);
            if (attempt > MAX_DEFER_ATTEMPTS) {
              yield* failSettled(a, 'media_prefill_failed',
                `deferral exhausted after ${MAX_DEFER_ATTEMPTS} attempts: ${r.error}`, rc);
            } else {
              writeDeferred(a, rc, attempt);
              deferred.push(m.src);
            }
            continue;
          }

          if (rc === -1 && !r.partial && !backendSuspect) {
            // Invalid input, state restored — the branch is intact and the
            // item is deterministic: retrying loops. Drop it and tell the
            // model what it did not see, on the same channel the
            // no-projector path already uses.
            // "Work from the text" needs the text: `resultStr` is the tool's
            // media-stripped result, the same object the no-projector path
            // decorates before it stringifies. On this rail it is always a
            // plain object — `takeToolMedia` yields media only from one, and
            // `processCompletion` always sets it — so parse and add the key.
            // A note that is only the key drops the answer.
            const told = JSON.parse(m.src.resultStr!) as Record<string, unknown>;
            const note = {
              ...told,
              [TOOL_IMAGE_ERROR_KEY]:
                `${m.src.toolName} returned media the decoder rejected as invalid input. ` +
                `Work from the text, or use a different source.`,
            };
            const noteStr = JSON.stringify(note);
            const noteTokens = buildToolResultDelta(
              ctx, noteStr, m.src.callId,
              { enableThinking: a.fmt.enableThinking });
            yield* waitUntilSettled(store.prefill([[a.branch, noteTokens]]));
            // The record carries what LANDED — the note, not the dropped item.
            bookSettled(a, m.src, noteTokens.length, undefined, noteStr);
            continue;
          }

          // Poisoned (2 / < -1), partial (an earlier chunk landed), an rc-less
          // failure, or the tripwire is up.
          if (rc === 2 || (rc !== undefined && rc < -1)) {
            consecutiveFatalRc++;
            if (consecutiveFatalRc >= BACKEND_TRIPWIRE_N) backendSuspect = true;
          }
          yield* failSettled(a, 'media_prefill_failed',
            backendSuspect
              ? `${r.error} [backend suspect: ${consecutiveFatalRc} consecutive fatal decodes — recreate the backend]`
              : r.error,
            rc);

          // HEAL (docs/self-healing.md): the poison cost this agent its
          // branch, not its task. Within budget and with the backend healthy,
          // queue a warm respawn — fork the spine (the prefix, seed images
          // included, rides for free), replay the record, re-admit. Drained
          // at the SPAWN phase, on the loop fiber, like everything else.
          const healAttempt = (healAttemptOf.get(a.id) ?? 0) + 1;
          const healSpec = specById.get(a.id);
          if (!backendSuspect && healAttempt <= MAX_HEAL_ATTEMPTS && healSpec) {
            // Replay up to the LAST COMPLETED TRANSACTION. The record's tail
            // is the poisoned transaction itself — an assistant turn whose
            // tool call never settled — and replaying it would leave the
            // replacement dangling mid-call (observed on real weights: the
            // model emits a stray think and stops instead of re-calling).
            // Dropping the tail lets the replacement REGENERATE that turn
            // and drive the tool itself.
            const records = recordFor(a.id).slice();
            while (records.length > 0 && records[records.length - 1].kind === 'assistant') {
              records.pop();
            }
            pendingHeals.push({
              spec: healSpec, records,
              of: a.id, ...(rc !== undefined ? { rc } : {}), attempt: healAttempt,
            });
          }
        }
      }

      // Re-activation runs over everything admitted this tick, on either rail.
      // Guarding it on `tokenItems` would strand a tick whose items were ALL
      // media: those agents would sit in awaiting_tool with their results
      // already in KV, and nothing would ever wake them.
      if (settledAgents.length > 0) {
        // Fan-out determinism: record the canonical scatter order so the replay
        // settle-order oracle can reproduce this exact interleaving. On the
        // serial path this equals dispatch order; the event is emitted uniformly.
        tw.write({ traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
          type: 'tool:settle_order', batch: settledOrder });

        // Probe prefill from DISPATCH or nudge-replacement.
        const probePairs: [Branch, number[]][] = [];
        const probeMeta: { id: number; cells: number; probeText: string }[] = [];
        for (const a of settledAgents) {
          if (poisoned.has(a.id)) continue;
          const probe = itemProbes.get(a.id);
          if (probe) {
            const probeTokens = ctx.tokenizeSync(probe, false);
            probePairs.push([a.branch, probeTokens]);
            probeMeta.push({ id: a.id, cells: probeTokens.length, probeText: probe });
          }
        }
        if (probePairs.length > 0) {
          yield* waitUntilSettled(store.prefill(probePairs));
          // Success-only, like every branch:prefill: written after the
          // batched dispatch landed, so a rejected prefill leaves no event
          // claiming cells that never moved.
          for (const m of probeMeta) {
            tw.write({ traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
              type: 'branch:prefill', branchHandle: m.id,
              cells: m.cells, role: 'probe', probeText: m.probeText });
            recordFor(m.id).push({ kind: 'probe', text: m.probeText });
          }
        }

        // Re-activate. An `extracting` agent (parallel recovery, queued by
        // handleRecover) gets the eager terminal-tool grammar instead of the lazy
        // tool-call grammar — the grammar-swap (#77). This forces a schema-valid
        // terminal call that `parseChatOutput` decodes; the report then decodes
        // bin-packed in the tick loop alongside live siblings.
        for (const a of settledAgents) {
          if (poisoned.has(a.id)) continue;
          a.transition('active');
          a.resetTurn();
          if (a.extracting && terminalGrammar) {
            a.branch.setGrammar(terminalGrammar);
          } else {
            applyLazyGrammar(a);
          }
        }
      }

      return deferred;
    }

    /** Transient-failure parking: a ToolRetryError'd call waits here with its
     *  agent in `awaiting_tool` (PRODUCE skips it — no turns, no tokens, no
     *  KV) until `notBefore`, then re-enters DISPATCH. Whether to park and
     *  for how long is the POLICY's call (`onToolRetry`); this queue is
     *  pure mechanism, like SETTLE's deferral. Keep retry delays above the
     *  provider's own breaker cooldown or the retry lands on an open
     *  breaker. */
    const pendingRetries: {
      agent: Agent; tc: ParsedToolCall; callId: string;
      notBefore: number; attempt: number;
    }[] = [];

    // ── Fan-out dispatch state ───────────────────────────────────
    // A `Tool.fanout` tool runs on a child fiber OFF the loop fiber; its child
    // pushes a ToolCompletion here on finish, and the loop fiber drains +
    // post-processes them in the DRAIN phase. A plain array is the same
    // cross-fiber rendezvous as pendingSpawns/pendingExtends — a child `push`
    // is atomic w.r.t. the single-threaded event loop and only the loop fiber
    // splices, so no lock is needed. Inline (`fanout` unset) tools never touch
    // this; with no tool flagged the whole mechanism is inert (today's path).
    const completedTools: ToolCompletion[] = [];
    // agentId → its in-flight tool child (≤1 per agent: PRODUCE emits one call
    // then parks the agent in awaiting_tool). Powers the termination guard now;
    // targeted wind-down halt later.
    const inflightTasks = new Map<number, Task<void>>();
    // Fired by a child on completion so the all-parked nap wakes immediately.
    const toolWake = createSignal<void, void>();
    const permits = makePermits(opts.maxConcurrentTools ?? DEFAULT_MAX_CONCURRENT_TOOLS);
    function* awaitToolCompletion(): Operation<void> {
      const sub = yield* toolWake;
      yield* sub.next();
    }

    // ── Graceful wind-down (drain) ──────────────────────────────────────
    // A pool-local flag the PRODUCE reap-branch + termination sweep read. The
    // watcher flips it ONCE when the consumer's WindDown signal fires, halts the
    // orchestrator (stop spawning — its `finally` sets orchestratorDone), and
    // wakes any all-parked nap via toolWake. The reap is pool-internal (no policy
    // surface); in-flight tools are NOT halted (they drain) — only `halt` aborts.
    // Parked RETRIES are abandoned at the next DISPATCH (see Phase 4): a drain
    // reports with what agents have, it never waits out a rate-limit park. The
    // flip is announced as `pool:windDown` (trace) + `run:windingDown` (bus).
    let windingDown = false;
    if (windDownSignal) {
      const wd = windDownSignal;
      yield* spawn(function*() {
        const sub = yield* wd;
        yield* sub.next();
        // Halt the orchestrator BEFORE flipping windingDown. The reap branch is
        // gated on windingDown, and a reap's idle-transition fires the agent's
        // statusSignal — which would resume the orchestrator's waitFor and let it
        // spawn/extend the next task. Halting first guarantees it's dead before
        // any reap can fire (the SEGV invariant: orchestrator halted before any
        // idle-transition). halt() resolves only after teardown completes (its
        // `finally` sets orchestratorDone); windingDown + toolWake are then set
        // synchronously (no yield between), so the woken loop always sees both.
        yield* orchestratorTask.halt();
        windingDown = true;
        toolWake.send();
        // Announce the flip (trace + bus) — the consumer's cue to show the
        // run as finishing. Emitted here, not at the first reap: with every
        // agent parked in a retry there IS no immediate reap, and the click
        // would read as ignored.
        tw.write({ traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
          type: 'pool:windDown' });
        yield* poolChannel.send({ type: 'run:windingDown' });
      });
    }

    // ── Targeted cancel (per-agent) ─────────────────────────────────────
    // The consumer `.send({agentId})`s CancelAgent (e.g. a per-card ×). Each emission
    // enqueues onto pendingCancels + wakes the loop; the tick drains it (below) →
    // halt that agent's in-flight tool + emit a terminal agent:failed + prune. Fires
    // repeatedly for individual agents, unlike WindDown (fire-once, whole cohort). The
    // orchestrator is NOT halted — siblings keep running.
    if (cancelSignal) {
      const cs = cancelSignal;
      yield* spawn(function*() {
        const sub = yield* cs;
        for (;;) {
          const next = yield* sub.next();
          if (next.done) break;
          pendingCancels.push(next.value.agentId);
          toolWake.send();
        }
      });
    }

    /** Discard queued user-cancels: halt the agent's in-flight tool (aborting
     *  the fetch; its `ensure` removes it from inflightTasks), emit a terminal
     *  agent:failed (NO recovery — the user killed it deliberately), then
     *  idle + prune to free KV for siblings. Only agent:failed is emitted (no
     *  preceding agent:done) so the UI resolves straight to "cancelled" with
     *  no recovering flash. safePrune only reclaims childless leaves — a
     *  parent/chain agent no-ops (its findings still feed dependents).
     *  Runs ONLY on the loop fiber, at its two stable points: the tick top,
     *  and INSIDE the pause hold — reclamation needs no decode, so the user
     *  can pause, evaluate trajectories, and cull an off-track agent live.
     *  Pause holds progression, not the axe. */
    function* drainCancels(): Operation<void> {
      for (const id of pendingCancels.splice(0)) {
        const a = agentById.get(id);
        if (!a || (a.status !== 'active' && a.status !== 'awaiting_tool')) continue;
        const tool = inflightTasks.get(id);
        if (tool) yield* tool.halt();
        tw.write({ traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
          type: 'pool:agentDrop', agentId: id, reason: 'user_cancel' });
        yield* poolChannel.send({ type: 'agent:failed', agentId: id, reason: 'user_cancel' });
        discardedIds.add(id);
        a.transition('idle');
        safePrune(a, tw, poolScopeId);
      }
    }

    // ── Pause watcher ───────────────────────────────────────────────────
    // Multi-fire like CancelAgent (pause toggles repeatedly). `pauseWake`
    // releases the hold on play; `toolWake` breaks an all-parked nap so the
    // loop reaches the hold promptly on pause. Sequencing conflicts
    // (wind-down while paused) are the consumer's to refuse — the pool
    // holds while paused, regardless.
    const pauseWake = createSignal<void, void>();
    if (pauseSignal) {
      const ps = pauseSignal;
      yield* spawn(function*() {
        const sub = yield* ps;
        for (;;) {
          const next = yield* sub.next();
          if (next.done) break;
          paused = next.value;
          pauseWake.send();
          toolWake.send();
        }
      });
    }

    /** Post-process one tool completion ON THE LOOP FIBER: tokenize the result,
     *  send events, write traces, and return a SettledTool to prefill — or null
     *  for a retry-park / error-kill. Shared by the inline path (called inline)
     *  and DRAIN (called when a fan-out child's completion arrives). The body is
     *  the relocated post-tool logic; relocating it onto the loop fiber is what
     *  keeps the main-context tokenize/reads off the child fibers. */
    /**
     * Fail ONE agent whose tool completion could not be processed.
     *
     * `processCompletion` can throw, and the media barrier is the live case:
     * `prepareBatch` / `deltaCells` reject, and `Ingress` DEFAULTS to
     * `NoContentIngress`, so any harness with an image-returning tool and no
     * media wiring hits this on the first call.
     *
     * Both call sites sit outside any `try`, so that throw unwound past the
     * tick loop into the pool's own catch — which closes the channel with a
     * PARTIAL result, no trace, and no `agent:failed`. Measured: two agents
     * spawn, one dispatches, and BOTH vanish with no terminal event and no
     * `pool:close`. The sibling had not even reached the failing path.
     *
     * This is the shape SETTLE already uses for a per-entry cohort failure
     * (see the `poisoned` loop): trace it, tell the bus, prune the branch,
     * park the agent — and record the DISCARD, so the termination sweep never
     * force-recovers it. That last step is the one this comment used to defer
     * to "a later phase"; the phase happened, `discardedIds` now means
     * "terminally failed, do not resurrect" rather than "user cancelled", and
     * all three discard paths write it.
     */
    function* failCompletion(c: ToolCompletion, err: unknown): Operation<void> {
      const a = c.agent;
      const detail = err instanceof Error ? err.message : String(err);
      tw.write({
        traceId: tw.nextId(), parentTraceId: c.dispatchTraceId, ts: performance.now(),
        type: 'pool:settleFailed', agentId: a.id, reason: 'tool_result_failed',
        detail: detail.slice(0, 200),
      });
      yield* poolChannel.send({ type: 'agent:failed', agentId: a.id, reason: 'tool_result_failed' });
      discardedIds.add(a.id);
      safePrune(a, tw, poolScopeId);
      a.transition('idle');
    }

    function* processCompletion(c: ToolCompletion): Operation<SettledTool | null> {
      const { agent, tc, callId, dispatchTraceId } = c;

      // Discarded by a user cancel while this tool was in flight: drop the completion
      // silently — no tool:result / agent:tool_result, no result set. The agent already
      // got its terminal agent:failed(user_cancel); a late tool event would contradict it.
      if (discardedIds.has(agent.id)) return null;

      if (c.kind === 'error') {
        agent.transition('idle');
        agent.setResult(`Tool error: ${c.err.message}`, 'tool_error');
        tw.write({ traceId: tw.nextId(), parentTraceId: dispatchTraceId, ts: performance.now(),
          type: 'tool:error', agentId: agent.id, tool: tc.name,
          error: c.err.message });
        return null;
      }

      if (c.kind === 'retry') {
        const attempt = c.retryAttempt;
        // Strategy is the policy's: park-and-retry (optionally overriding the
        // tool's delay estimate) or fail the call so the model can pivot. Hook
        // absent → one retry at the tool's estimate.
        const retryAction: ToolRetryAction =
          policy.onToolRetry?.(agent, tc.name, c.err, attempt)
            ?? (attempt <= 1 ? { type: 'retry' } : { type: 'fail' });
        if (retryAction.type === 'retry') {
          // Park: no SettledTool, nothing prefilled — the agent's KV never sees
          // transient infrastructure weather. Emitted as an `agent:tool_retry`
          // event (+ `tool:retry` trace) so a consumer can distinguish a
          // waiting agent from a hung one.
          const afterMs = retryAction.afterMs ?? c.err.retryAfterMs;
          pendingRetries.push({
            agent, tc, callId,
            notBefore: performance.now() + afterMs,
            attempt,
          });
          yield* poolChannel.send({
            type: 'agent:tool_retry', agentId: agent.id, tool: tc.name,
            retryAfterMs: afterMs, attempt,
          });
          tw.write({ traceId: tw.nextId(), parentTraceId: dispatchTraceId, ts: performance.now(),
            type: 'tool:retry', agentId: agent.id, tool: tc.name,
            callId, retryAfterMs: afterMs, attempt });
          return null;
        }
        // Policy chose fail — the outage is now a fact the model needs. Settle
        // an honest, directive result through the normal path (NOT the
        // tool_error path, which kills the agent's run).
        const exhausted = {
          error: retryAction.message
            ?? `${tc.name} is currently unavailable (rate-limited; retry failed). ` +
              `Do not call ${tc.name} again — use other sources or proceed with your current findings.`,
        };
        const resultStr = JSON.stringify(exhausted);
        yield* poolChannel.send({ type: 'agent:tool_result', agentId: agent.id, tool: tc.name, result: resultStr });
        const prefillTokens = buildToolResultDelta(ctx, resultStr, callId, { enableThinking: agent.fmt.enableThinking });
        tw.write({ traceId: tw.nextId(), parentTraceId: dispatchTraceId, ts: performance.now(),
          type: 'tool:result', agentId: agent.id, tool: tc.name,
          result: exhausted, cells: prefillTokens.length,
          durationMs: performance.now() - c.toolT0 });
        return { rail: 'token', agentId: agent.id, prefillTokens, toolName: tc.name, callId, args: tc.arguments, probe: undefined, resultStr };
      }

      // c.kind === 'result'
      const result = c.result;
      const tool = tools.get(tc.name);
      const postToolPressure = new ContextPressure(ctx, pressureOpts);
      const contextAvailablePercent = postToolPressure.percentAvailable;
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        (result as Record<string, unknown>)[TOOL_CONTEXT_KEY] = contextAvailablePercent;
        const resultObj = result as Record<string, unknown>;
        if (Array.isArray(resultObj.results)) {
          agent.addNestedResults((resultObj.results as unknown[]).filter((f): f is string => typeof f === 'string'));
        }
        if (Array.isArray(resultObj.nestedResults)) {
          agent.addNestedResults((resultObj.nestedResults as unknown[]).filter((f): f is string => typeof f === 'string'));
        }
      }
      // Images come OUT before serializing — see TOOL_MEDIA_KEY. A model with
      // no projector cannot be handed them, and dropping them silently would
      // leave the agent reasoning about a picture it was never shown, so say
      // so in the result text instead: an honest failure the model can read,
      // the same shape the rate-limit path uses above.
      const { media, result: told } = takeToolMedia(result);
      if (media.length > 0 && !ctx.supportsVision()) {
        (told as Record<string, unknown>)[TOOL_IMAGE_ERROR_KEY] =
          `${tc.name} returned ${media.length} image(s), but this model cannot see images. ` +
          `Work from the text, or use a different source.`;
      }
      const resultStr = JSON.stringify(told);
      yield* poolChannel.send({ type: 'agent:tool_result', agentId: agent.id, tool: tc.name, result: resultStr, contextAvailablePercent });

      // Two rails, one seam. The token rail tokenizes here; the embedding rail
      // stops at the string stage because mtmd tokenizes downstream, and its
      // cost has to be MEASURED (image cost is non-linear — a per-image
      // estimate over-commits) before SETTLE can spend it against headroom.
      // Measured on the loop fiber, never inside a fan-out `execute()`.
      let prefillTokens: number[] = [];
      let mediaItem: { delta: MultimodalDelta; cells: number; attachments: readonly Attachment[] } | undefined;
      if (media.length > 0 && ctx.supportsVision()) {
        // THE BARRIER for this ingress: the whole batch is normalized and
        // committed before a marker exists, before admission, before any KV
        // moves. `delta` then carries the ADMITTED representations, so the
        // cells measured here are the cells replay will rebuild.
        //
        // A failure is NOT a tool retry: the tool already ran and may have had
        // an external side effect, so re-running it is not a neutral act. The
        // agent fails through the existing recovery path instead, and its
        // branch is pruned — never silently dropped, and never repeated.
        const prepared = yield* prepareBatch(ingress, attachments, media);
        const delta = buildToolResultDeltaMultimodal(
          ctx, resultStr, callId, prepared.bitmaps as Uint8Array[],
          { enableThinking: agent.fmt.enableThinking });
        mediaItem = {
          delta,
          cells: yield* waitUntilSettled(deltaCells(ctx, delta)),
          attachments: prepared.attachments,
        };
      } else {
        prefillTokens = buildToolResultDelta(ctx, resultStr, callId, { enableThinking: agent.fmt.enableThinking });
      }
      // `told` throughout, never `result`: the probe reads what the model was
      // told, and the trace records it. Image bytes reach the cache down the
      // embedding rail and belong in neither.
      const probe = tool?.probe(told) ?? undefined;
      tw.write({ traceId: tw.nextId(), parentTraceId: dispatchTraceId, ts: performance.now(),
        type: 'tool:result', agentId: agent.id, tool: tc.name,
        result: told, cells: mediaItem?.cells ?? prefillTokens.length,
        durationMs: performance.now() - c.toolT0 });
      const common = { agentId: agent.id, toolName: tc.name, callId, args: tc.arguments, probe, resultStr };
      return mediaItem
        ? { rail: 'media', ...common, media: mediaItem }
        : { rail: 'token', ...common, prefillTokens };
    }

    /** DISPATCH: run inline tools on the loop fiber, spawn fan-out tools off it.
     *  Inline results return for next tick's SETTLE; fan-out completions arrive
     *  via `completedTools` and are processed in DRAIN. */
    function* dispatch(calls: { agent: Agent; tc: ParsedToolCall; retryAttempt?: number; retryCallId?: string }[]): Operation<SettledTool[]> {
      const results: SettledTool[] = [];

      for (const { agent, tc, retryAttempt, retryCallId } of calls) {
        let toolArgs: Record<string, unknown>;
        try { toolArgs = JSON.parse(tc.arguments); } catch { toolArgs = {}; }
        const callId = retryCallId ?? (tc.id || `call_${agent.toolCallCount}`);

        // Retries re-execute the SAME call — turn/tool-call counters and the
        // agent:tool_call event belong to the original attempt only.
        if (retryAttempt === undefined) {
          agent.incrementToolCalls();
          totalToolCalls++;
          agent.incrementTurns();

          yield* poolChannel.send({ type: 'agent:tool_call', agentId: agent.id, tool: tc.name, args: tc.arguments });
        }

        const tool = tools.get(tc.name);
        const dispatchPressure = new ContextPressure(ctx, pressureOpts);
        const explore = policy.shouldExplore?.(agent, dispatchPressure) ?? true;

        const dispatchTraceId = tw.nextId();
        const toolT0 = performance.now();
        tw.write({
          traceId: dispatchTraceId, parentTraceId: poolScopeId, ts: toolT0,
          type: 'tool:dispatch', agentId: agent.id, tool: tc.name,
          toolIndex: toolIndexMap.get(tc.name) ?? -1, toolkitSize,
          args: toolArgs, callId,
          explore, percentAvailable: dispatchPressure.percentAvailable,
        });
        const peerHistory = agents
          .filter(a => a.id !== agent.id)
          .flatMap(a => a.toolHistory);
        const toolContext: ToolContext = {
          agentId: agent.id, branch: agent.branch,
          onProgress: (p: { filled: number; total: number }) => {
            progressBridge.send({ type: 'agent:tool_progress', agentId: agent.id, tool: tc.name, filled: p.filled, total: p.total });
          },
          scorer: opts.scorer, explore,
          pressurePercentAvailable: dispatchPressure.percentAvailable,
          peerHistory,
        };

        // ── execute ──
        if (tool?.fanout) {
          // Fan-out: spawn OFF the loop fiber. The child runs ONLY execute() (a
          // fanout tool issues no main-context op); the post-processing — which
          // tokenizes/reads the main ctx — runs in DRAIN on the loop fiber. The
          // agent stays awaiting_tool until its result settles. The child is a
          // child task of the tick-loop task, so pool teardown / wind-down
          // halts it (→ cancellableFetch aborts) for free.
          const fanoutTool = tool;  // narrowed non-null by tool?.fanout
          inflightTasks.set(agent.id, yield* spawn(function*() {
            let took = false;
            try {
              // Own this agent's inflightTasks entry: remove it on ANY exit —
              // completion OR halt (wind-down/teardown). A halt unwinds via
              // ensure (not catch), so it pushes no completion and DRAIN never
              // runs for it; without this the stale entry keeps `fanoutQuiet`
              // false and the loop never terminates.
              yield* ensure(() => { inflightTasks.delete(agent.id); });
              yield* ensure(() => { if (took) permits.release(); });
              yield* permits.acquire(); took = true;
              // Per-tool TRACE/CALLER context set INSIDE the child so concurrent
              // tools never clobber each other's (stronger isolation than the
              // shared loop-fiber set the inline path uses).
              yield* TraceParent.set(dispatchTraceId);
              yield* CallingAgent.set(agent);
              yield* Trace.set(toolTee(agent.id, callId, dispatchTraceId));
              const result: unknown = yield* scoped(function*() {
                return yield* call(() => fanoutTool.execute(toolArgs, toolContext));
              });
              completedTools.push({ kind: 'result', agent, tc, callId, dispatchTraceId, toolT0, result });
            } catch (err) {
              // A halt unwinds via ensure/finally, NOT catch — a halted child
              // skips the push (its result correctly discarded); catch only ever
              // sees real tool errors (incl. ToolRetryError).
              if (err instanceof ToolRetryError) {
                completedTools.push({ kind: 'retry', agent, tc, callId, dispatchTraceId, toolT0, retryAttempt: (retryAttempt ?? 0) + 1, err });
              } else {
                completedTools.push({ kind: 'error', agent, tc, callId, dispatchTraceId, err: toError(err) });
              }
            } finally {
              toolWake.send();
            }
          }));
          continue;
        }

        // ── inline (default) ──
        // Run execute + post-process now, on the loop fiber — functionally the
        // pre-fan-out path. Required for any tool that decodes on the main
        // context (delegate, plan) and for the unknown-tool fallback below.
        let completion: ToolCompletion;
        try {
          yield* TraceParent.set(dispatchTraceId);
          yield* CallingAgent.set(agent);
          yield* Trace.set(toolTee(agent.id, callId, dispatchTraceId));

          // Unknown-tool messaging branches on toolkit emptiness: a no-tool
          // agent emitting tool calls is imitating markup from its context
          // (inherited spine KV or contaminated findings) — a generic
          // "Unknown tool" error reads as transient and invites rephrased
          // retries until maxTurns (observed: trace-2026-06-11T00-02 synth,
          // 10 turns of mimicry). The directive form names the actual
          // situation so the model can recover in one turn.
          const result: unknown = yield* scoped(function*() {
            return yield* call(() =>
              tool ? tool.execute(toolArgs, toolContext) : Promise.resolve({
                error: tools.size === 0
                  ? 'No tools are available to this agent. Do not emit tool calls — write your answer directly as plain text.'
                  : `Unknown tool: ${tc.name}`,
              })
            );
          });
          completion = { kind: 'result', agent, tc, callId, dispatchTraceId, toolT0, result };
        } catch (err) {
          completion = err instanceof ToolRetryError
            ? { kind: 'retry', agent, tc, callId, dispatchTraceId, toolT0, retryAttempt: (retryAttempt ?? 0) + 1, err }
            : { kind: 'error', agent, tc, callId, dispatchTraceId, err: toError(err) };
        }
        let settled: SettledTool | null = null;
        try {
          settled = yield* processCompletion(completion);
        } catch (err) {
          // One agent's post-tool failure must not take the tick — or its
          // siblings — with it. See failCompletion.
          yield* failCompletion(completion, err);
        }
        if (settled) results.push(settled);
      }

      return results;
    }

    // ── Four-phase tick loop ─────────────────────────────────
    let pendingSettled: SettledTool[] = [];

    // ── Four-phase tick loop ─────────────────────────────────
    let recoveryAttempted = false;
    for (;;) {
      // -- Pause: hold at the tick boundary. Branches stay resident; tool
      // completions queue as data and settle on the first tick after play.
      // Policy time reads runNow (this hold is excluded); retry parks stay
      // on the wall clock — rate limits elapse in the real world.
      if (paused) {
        const heldAt = performance.now();
        tw.write({ traceId: tw.nextId(), parentTraceId: poolScopeId, ts: heldAt, type: 'pool:pause' });
        yield* poolChannel.send({ type: 'run:paused' });
        // Subscribe BEFORE re-checking `paused`: emissions buffer on a live
        // subscription, so a play (or wake) landing during subscription setup
        // is never missed. toolWake is raced too — a user cancel arriving
        // mid-hold drains HERE, on this suspended loop fiber (no decode in
        // flight — the safest prune there is): pause, evaluate trajectories,
        // cull the off-track agent, play. Pause holds progression, not the axe.
        const pauseSub = yield* pauseWake;
        const toolSub = yield* toolWake;
        while (paused) {
          yield* race([pauseSub.next(), toolSub.next()]);
          if (pendingCancels.length > 0) yield* drainCancels();
        }
        const pausedMs = performance.now() - heldAt;
        pausedTotal += pausedMs;
        tw.write({ traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(), type: 'pool:resume', pausedMs });
        yield* poolChannel.send({ type: 'run:resumed', pausedMs });
      }

      // Idle until orchestrator enqueues work (spawn or extend) or completes.
      // Include pendingExtends: the final extend after the last task in chain
      // mode must drain before the loop exits, otherwise the orchestrator fiber
      // is left suspended on a dead action.
      if (
        agents.length === 0
        && pendingSpawns.length === 0
        && pendingExtends.length === 0
      ) {
        if (orchestratorDone) break;
        yield* sleep(1);
        continue;
      }

      // -- Phase 0: SPAWN+EXTEND -- drain pending spawns AND pending extends,
      // batching all fork-suffix prefills and extend-onto-spine prefills into
      // ONE native store.prefill call. All store-level native calls in this
      // pool are issued from this fiber (the tick loop), never concurrently
      // with the orchestrator's fiber. Piggybacking extend in this phase
      // preserves the continuous-tree-batching invariant (one GPU round-trip
      // per tick) and naturally atomic-orders both kinds of work.
      if (pendingSpawns.length > 0 || pendingExtends.length > 0 || pendingHeals.length > 0) {
        const drainedSpawns = pendingSpawns.splice(0, pendingSpawns.length);
        const drainedExtends = pendingExtends
          .splice(0, pendingExtends.length)
          .filter(e => !e.discarded);

        // Heals fork the spine and batch their suffix prefills with the
        // spawns — a heal IS a spawn wearing a lineage (docs/self-healing.md).
        // The record replay runs after the batch, per replacement.
        const drainedHeals: {
          h: (typeof pendingHeals)[number];
          agent: Agent; suffixTokens: number[]; formattedPrompt: string;
        }[] = [];
        for (const h of pendingHeals.splice(0)) {
          const setup = yield* setupAgent(spine, h.spec, ctx, enableThinking, runNow);
          drainedHeals.push({ h, ...setup });
        }

        const prefillPairs: [Branch, number[]][] = [
          ...drainedSpawns.map(s => [s.agent.branch, s.suffixTokens] as [Branch, number[]]),
          ...drainedHeals.map(d => [d.agent.branch, d.suffixTokens] as [Branch, number[]]),
          ...drainedExtends.map(e => [spine, e.tokens] as [Branch, number[]]),
        ];

        try {
          if (prefillPairs.length > 0) {
            yield* waitUntilSettled(store.prefill(prefillPairs));
          }
        } catch (err) {
          for (const e of drainedExtends) e.reject(err as Error);
          throw err;
        }

        // Resolve extend requests with the delta token count. spine.position
        // has advanced by the sum of extend token counts at this point.
        for (const e of drainedExtends) {
          tw.write({
            traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
            type: 'spine:extend',
            userContent: e.userContent,
            assistantContent: e.assistantContent,
            deltaTokens: e.tokens.length,
            positionAfter: spine.position,
          });
          e.resolve(e.tokens.length);
        }

        for (const s of drainedSpawns) {
          specById.set(s.agent.id, s.task);
          tw.write({
            traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
            type: 'branch:create', branchHandle: s.agent.id, parentHandle: s.agent.parentId,
            position: s.agent.forkHead, role: 'agentFork',
          });
          tw.write({
            traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
            type: 'prompt:format', agentId: s.agent.id, promptText: s.formattedPrompt,
            taskContent: s.task.content, tokenCount: s.suffixTokens.length,
            messages: JSON.stringify([
              { role: 'system', content: s.task.systemPrompt },
              { role: 'user', content: s.task.content },
            ]),
            tools: s.task.tools, role: 'agentSuffix',
          });
          applyLazyGrammar(s.agent);
          // transition fires agent.statusSignal — ctx.spawn's subscriber is waiting on this.
          s.agent.transition('active');
          // Trace before the suspending bus send — same contract as
          // traceAgentDone: the span's start must not absorb subscriber
          // backpressure or vanish on a cancellation mid-send.
          tw.write({
            traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
            type: 'agent:spawn', agentId: s.agent.id, parentAgentId: s.agent.parentId,
            ...(s.task.after && s.task.after.length > 0 ? { after: s.task.after } : {}),
          });
          yield* poolChannel.send({ type: 'agent:spawn', agentId: s.agent.id, parentAgentId: s.agent.parentId, ...(s.task.after && s.task.after.length > 0 ? { after: s.task.after } : {}) });
        }

        // Finish the heals: replay each replacement's record onto its fork
        // (the suffix batched above; the prefix rode the fork), then admit it
        // as a NEW agent. The original's `agent:failed` stands — this is a
        // lineage, not a resurrection.
        for (const { h, agent, suffixTokens, formattedPrompt } of drainedHeals) {
          agents.push(agent);
          agentById.set(agent.id, agent);
          specById.set(agent.id, h.spec);
          healAttemptOf.set(agent.id, h.attempt);
          tw.write({
            traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
            type: 'branch:create', branchHandle: agent.id, parentHandle: agent.parentId,
            position: agent.forkHead, role: 'agentFork',
          });
          tw.write({
            traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
            type: 'prompt:format', agentId: agent.id, promptText: formattedPrompt,
            taskContent: h.spec.content, tokenCount: suffixTokens.length,
            messages: JSON.stringify([
              { role: 'system', content: h.spec.systemPrompt },
              { role: 'user', content: h.spec.content },
            ]),
            tools: h.spec.tools, role: 'agentSuffix',
          });
          try {
            yield* replayAgentTurns(agent.branch, h.records,
              { enableThinking: agent.fmt.enableThinking });
          } catch (e) {
            // The replay could not land (capacity, missing content, a second
            // decode failure). Best-effort ends here: the original already
            // failed honestly; discard the half-built replacement.
            tw.write({ traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
              type: 'pool:agentDrop', agentId: agent.id, reason: 'pressure_init' });
            if (!agent.branch.disposed) safePrune(agent, tw, poolScopeId);
            agent.transition('idle');
            discardedIds.add(agent.id);
            continue;
          }
          const hp = new ContextPressure(ctx, pressureOpts);
          tw.write({
            traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
            type: 'pool:agentHeal', of: h.of, agentId: agent.id,
            ...(h.rc !== undefined ? { rc: h.rc } : {}), attempt: h.attempt,
            pressure: { remaining: finiteOrNull(hp.remaining), cellsUsed: hp.cellsUsed,
              nCtx: hp.nCtx, headroom: finiteOrNull(hp.headroom) },
          });
          applyLazyGrammar(agent);
          agent.transition('active');
          tw.write({
            traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
            type: 'agent:spawn', agentId: agent.id, parentAgentId: agent.parentId,
            ...(h.spec.after && h.spec.after.length > 0 ? { after: h.spec.after } : {}),
          });
          yield* poolChannel.send({ type: 'agent:spawn', agentId: agent.id, parentAgentId: agent.parentId, ...(h.spec.after && h.spec.after.length > 0 ? { after: h.spec.after } : {}) });
        }
      }

      // If all we had was pending spawns, and none of them activated (shouldn't happen
      // normally — SPAWN always transitions to active), nothing to produce. Loop back.
      if (agents.length === 0) continue;

      // -- Targeted cancel (user_cancel) — drained at the stable point.
      if (pendingCancels.length > 0) yield* drainCancels();

      // -- Phase 1: PRODUCE -- sample from active agents, collect tool calls
      policy.resetTick?.();
      const pressure = new ContextPressure(ctx, pressureOpts);
      // Live agents = the in-flight set that could still need recovery: `active`
      // (researching / producing a forced report) or `awaiting_tool`. Explicitly NOT
      // `idle` (done-with-result, dropped, OR just-spawned-not-yet-activated) and NOT
      // `disposed`. The in-loop recovery budget `b` is a fair share of headroom across
      // them, so the whole cohort's reports fit without one agent claiming it all.
      const aliveCount = agents.filter(x => x.status === 'active' || x.status === 'awaiting_tool').length;

      // A VOLUNTARY terminal report is bounded too: past the cap a stream is
      // repeating, not deepening. The word advisory (tokenBudgetAsWords) is
      // the primary cap; this is the same guillotine recovery reports get.
      const voluntaryReportCap = Math.min(policy.reportBudget ?? MAX_REPORT_BUDGET, MAX_REPORT_BUDGET);

      const entries: [Branch, number][] = [];
      const toolCalls: { agent: Agent; tc: ParsedToolCall }[] = [];
      const nudges: SettledTool[] = [];

      for (const a of agents) {
        if (a.status !== 'active') continue;

        // Wind-down (drain): recover active agents IN-LOOP (bin-packed for a fast
        // drain) instead of deferring to a sweep — wind-down always bin-packs,
        // regardless of effort. An agent mid-terminal-tool (emitting its voluntary
        // report) is left to finish — same guard as shouldExit's terminal
        // protection; an already-extracting agent is left to finish its report.
        // SEGV-safe: the orchestrator was halted before windingDown flipped, so no
        // concurrent spawn/prefill races handleRecover's prefill.
        if (windingDown && !a.extracting && !isEmittingTerminal(a, terminalToolName)) {
          tw.write({ traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
            type: 'pool:agentDrop', agentId: a.id, reason: 'wind_down' });
          traceAgentDone(tw, poolScopeId, a.id);
          yield* poolChannel.send({ type: 'agent:done', agentId: a.id });
          const settled = yield* handleRecover(a, policy, ctx, pressureOpts, aliveCount, poolChannel, tw, poolScopeId);
          if (settled) nudges.push(settled);
          continue;
        }

        // Kill on pressure/time. An extracting agent (producing its forced
        // recovery report) is exempt — its token-stop cap (with `b` sized so the whole
        // cohort fits headroom) keeps it within KV; if it overshoots, the tick-loop
        // catch yields partials.
        const policyExit = policy.shouldExit?.(a, pressure);
        if (!a.extracting && (policyExit ?? pressure.critical)) {
          // Entry above requires `policyExit ?? pressure.critical` to be truthy, so exactly
          // two cases reach here: the policy said exit, or it abstained (undefined) and
          // pressure is critical. A policy returning `false` never enters — `??` falls
          // through only on null/undefined. The old third branch was unreachable.
          // Entry requires `policyExit ?? pressure.critical` truthy, so the old third
          // branch was unreachable: policyExit===false never enters (`??` falls through
          // only on null/undefined), and policyExit===undefined enters only when
          // critical. Precedence is kept — when BOTH hold, pressure is the cause and
          // the policy merely agreed.
          const exitReason = pressure.critical ? 'pressure_critical' as const
            : 'policy_exit' as const;
          a.exitReason = exitReason;
          tw.write({ traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
            type: 'pool:agentDrop', agentId: a.id, reason: exitReason });
          traceAgentDone(tw, poolScopeId, a.id);
          yield* poolChannel.send({ type: 'agent:done', agentId: a.id });
          if (isEmittingTerminal(a, terminalToolName)) {
            // The agent was already producing its OWN report when the critical kill
            // fired. DON'T prefill a fresh recovery turn — that discards the in-flight
            // report and restarts it from scratch (the "report resets + restarts" bug),
            // then re-decodes into the already-exhausted KV and fails. Salvage the
            // partial terminal call it has already emitted (parseChatOutput handles the
            // truncation); no further decode is needed.
            // producedTokens = the report turn's tokens, not cumulative: `resetTurn`
            // clears `rawOutput` (not `tokenCount`), so `rawOutput` is just the in-flight
            // report — report-scoped + consistent with the in-loop path's `recoveryTokens`.
            yield* finishRecovery(a, a.rawOutput, ctx.tokenizeSync(a.rawOutput, false).length, poolChannel, tw, poolScopeId, ctx, terminalToolName);
            a.transition('idle');
            safePrune(a, tw, poolScopeId);
          } else if (policy.recoveryShape === 'parallel') {
            // In-loop: inject the recovery turn; SETTLE re-activates it (capped
            // report grammar) and the report decodes bin-packed with live agents.
            const settled = yield* handleRecover(a, policy, ctx, pressureOpts, aliveCount, poolChannel, tw, poolScopeId);
            if (settled) nudges.push(settled);
          } else {
            // Staggered: blocking recoverInline, BEFORE the idle transition —
            // otherwise the statusSignal fires 'idle' mid-recovery, waitFor
            // returns early, the orchestrator resumes + prefills the next task
            // while this branch is still decoding → concurrent native call → SEGV.
            yield* recoverInline(a, policy, ctx, store, tw, poolScopeId, poolChannel, pressureOpts, terminalGrammar, terminalToolName);
            a.transition('idle');
          }
          continue;
        }

        // Token-stop backstop: an extracting agent that has produced its full report
        // budget is force-finished here (its partial tool-call salvaged via
        // parseChatOutput) rather than decoding further — this BOUNDS each in-loop
        // report so a non-compliant model can't blow past the prompt's word advisory
        // and exhaust KV. The prompt budget is the primary cap; this is the guillotine.
        if (a.extracting && a.recoveryTokens >= a.recoveryBudget) {
          yield* completeExtraction(a, poolChannel, tw, poolScopeId, ctx, pressureOpts, terminalToolName);
          continue;
        }

        // The voluntary report's guillotine: an agent emitting its OWN
        // terminal call past the cap is force-finished exactly like the
        // pressure-kill salvage — the partial call parses (truncation-
        // tolerant), the report lands, the branch is pruned. Without this,
        // a degenerating report decodes until KV death.
        if (!a.extracting && isEmittingTerminal(a, terminalToolName) && a.turnTokens >= voluntaryReportCap) {
          a.exitReason = 'report_cap';
          tw.write({ traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
            type: 'pool:agentDrop', agentId: a.id, reason: 'report_cap' });
          traceAgentDone(tw, poolScopeId, a.id);
          yield* poolChannel.send({ type: 'agent:done', agentId: a.id });
          yield* finishRecovery(a, a.rawOutput, a.turnTokens, poolChannel, tw, poolScopeId, ctx, terminalToolName);
          a.transition('idle');
          safePrune(a, tw, poolScopeId);
          continue;
        }

        const { token, text, isStop } = a.branch.produceSync();
        if (isStop) {
          if (a.extracting) {
            // The forced recovery report finished — extract + idle + child-safe
            // prune (the KV is dead weight). `agent:done` already fired at recovery
            // entry; completeExtraction emits `agent:recovered`.
            yield* completeExtraction(a, poolChannel, tw, poolScopeId, ctx, pressureOpts, terminalToolName);
            continue;
          }
          const parsed = a.finalize(ctx);

          tw.write({
            traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
            type: 'agent:turn', agentId: a.id, turn: a.turns,
            rawOutput: a.rawOutput,
            parsedContent: parsed.content || null,
            parsedToolCalls: parsed.toolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments })),
          });
          recordFor(a.id).push({ kind: 'assistant', text: a.rawOutput });

          // Policy decides what to do with the parsed output
          const action = policy.onProduced(a, parsed, pressure, policyConfig);

          switch (action.type) {
            case 'free_text_return':
              yield* handleFreeTextReturn(a, action.content, poolChannel, tw, poolScopeId);
              continue;
            case 'idle':
              // Parallel: recover in-loop at the stop (no termination sweep for
              // parallel). Staggered: idle now, recovered at the sweep.
              if (policy.recoveryShape === 'parallel') {
                if (action.reason !== 'free_text_stop') {
                  tw.write({ traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
                    type: 'pool:agentDrop', agentId: a.id,
                    reason: action.reason === 'max_turns' ? 'maxTurns' : 'pressure_softcut' });
                }
                traceAgentDone(tw, poolScopeId, a.id);
                yield* poolChannel.send({ type: 'agent:done', agentId: a.id });
                const settled = yield* handleRecover(a, policy, ctx, pressureOpts, aliveCount, poolChannel, tw, poolScopeId);
                if (settled) nudges.push(settled);
              } else {
                yield* handleIdleDrop(a, action.reason, poolChannel, tw, poolScopeId);
              }
              continue;
            case 'nudge':
              // authGuard rejection: emit the structured
              // tool:authReject event BEFORE the generic agentNudge so a
              // single trace pass captures attribution + rejection context.
              if (action.guard === 'auth_reject') {
                tw.write({
                  traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
                  type: 'tool:authReject',
                  agentId: a.id,
                  assignedAbility: a.assignedAbility,
                  attemptedTool: parsed.toolCalls[0].name,
                  lineageHistory: a.walkAncestors((x) => x.toolHistory),
                });
              }
              nudges.push(yield* handleNudge(a, action.message, parsed.toolCalls[0], ctx, tools));
              tw.write({ traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
                type: 'pool:agentNudge', agentId: a.id, reason: 'nudge', message: action.message,
                tool: parsed.toolCalls[0]?.name, args: parsed.toolCalls[0]?.arguments, guard: action.guard });
              continue;
            case 'return':
              yield* handleReturn(a, action.result, parsed.toolCalls[0], terminalToolName!, pruneOnReturn, poolChannel, tw, poolScopeId);
              totalToolCalls++;
              continue;
            case 'tool_call':
              a.transition('awaiting_tool');
              toolCalls.push({ agent: a, tc: action.tc });
              a.resetTurn();
              continue;
          }
        }

        entries.push([a.branch, token]);
        if (trace) {
          const entropy = a.branch.modelEntropy();
          const surprisal = a.branch.modelSurprisal(token);
          a.accumulateTokenWithTrace(text, entropy, surprisal);
          a.observe(ctx);
          yield* poolChannel.send({
            type: 'agent:produce', agentId: a.id, text, tokenCount: a.tokenCount,
            entropy, surprisal,
          });
        } else {
          a.accumulateToken(text);
          a.observe(ctx);
          yield* poolChannel.send({ type: 'agent:produce', agentId: a.id, text, tokenCount: a.tokenCount });
        }
      }

      // -- Phase 2: COMMIT -- batch-decode produced tokens
      if (entries.length > 0) {
        try {
          yield* waitUntilSettled(store.commit(entries));
        } catch (e) {
          // Decode OOM (concurrent in-loop reports exhausted KV) tears down the pool.
          // This batch is where admitted extractors decode their reports; unlike the
          // blocking `recoverInline` path (its own scope_error catch), an in-loop
          // extractor here would be orphaned with NO terminal event → eternal "writing
          // report" spinner. Announce each in-flight extractor failed BEFORE propagating
          // (the KV is exhausted — the run can't continue, so rethrow after).
          const reason = `scope_error: ${(e as Error).message ?? 'unknown'}`;
          for (const a of agents) {
            if (!a.extracting || a.status !== 'active') continue;
            tw.write({ traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
              type: 'pool:recoveryFailed', agentId: a.id, reason, outputExcerpt: a.rawOutput.slice(0, 200) });
            yield* poolChannel.send({ type: 'agent:failed', agentId: a.id, reason });
          }
          throw e;
        }
        steps++;
        const commitPressure = new ContextPressure(ctx, pressureOpts);
        // One `pool:tick` per batched decode — the trace-side pressure series
        // (the bus `agent:tick` below is its live twin).
        tw.write({
          traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
          type: 'pool:tick', phase: 'COMMIT',
          activeAgents: agents.filter(x => x.status === 'active' || x.status === 'awaiting_tool').length,
          pressure: {
            remaining: finiteOrNull(commitPressure.remaining), cellsUsed: commitPressure.cellsUsed,
            nCtx: commitPressure.nCtx, headroom: finiteOrNull(commitPressure.headroom),
          },
        });
        yield* poolChannel.send({ type: 'agent:tick', cellsUsed: commitPressure.cellsUsed, nCtx: commitPressure.nCtx });
      }

      // -- Phase 2.5: DRAIN -- post-process fan-out tools that finished since
      // the last tick, ON THE LOOP FIBER (their tokenize/ctx reads happen here,
      // never in the child). Each becomes a SettledTool for THIS tick's SETTLE.
      const newlySettled: SettledTool[] = [];
      if (completedTools.length > 0) {
        for (const c of completedTools.splice(0)) {
          // The inflightTasks entry was already removed by the child's `ensure`
          // (runs synchronously on completion before the loop resumes — and on
          // halt too, which is the case DRAIN can't see). DRAIN just post-processes.
          let settled: SettledTool | null = null;
          try {
            settled = yield* processCompletion(c);
          } catch (err) {
            yield* failCompletion(c, err);
          }
          if (settled) newlySettled.push(settled);
        }
      }

      // -- Phase 3: SETTLE (settle what fits, defer what doesn't)
      const toSettle = [...pendingSettled, ...nudges, ...newlySettled];
      const deferred = toSettle.length > 0 ? yield* settle(toSettle) : [];

      // Stall-breaker: `deferred` has items but no active siblings can free
      // KV. Consult policy per deferred item — the policy is the "last
      // resort" decision point (staggered-exit for parallel orchestration
      // still works because defer-on-oversize above lets items wait while
      // siblings are active; only when ALL siblings are awaiting_tool or
      // idle do we reach here). Distinct drop reasons:
      //   - `pressure_settle_reject` — policy said idle, or nudge but the
      //     nudge payload itself doesn't fit (policy suggestion infeasible).
      //   - `settle_stall_break` — policy hook absent (legacy fallback).
      if (deferred.length > 0 && !agents.some(a => a.status === 'active')) {
        const stallPressure = new ContextPressure(ctx, pressureOpts);
        let stallHeadroom = stallPressure.headroom;
        const resolved: SettledTool[] = [];

        for (const item of deferred) {
          const a = agentById.get(item.agentId);
          if (!a || a.status !== 'awaiting_tool' || a.branch.disposed) continue;

          // rc-deferred items (docs/self-healing.md) ride THROUGH the
          // stall-break: their retry is a re-DISPATCH — a transient rc 1 can
          // clear without a sibling freeing KV — and they carry their own
          // budget (MAX_DEFER_ATTEMPTS terminates them within bounded ticks).
          // Headroom-deferred items have no deferAttempts entry and keep the
          // existing policy consult below.
          if (deferAttempts.has(item.agentId)) { resolved.push(item); continue; }

          const action = policy.onSettleReject?.(a, settledCells(item), stallPressure, policyConfig);

          if (action?.type === 'nudge') {
            // Record the policy's decision regardless of whether the
            // nudge itself fits — the event captures "policy consulted,
            // returned nudge" which is separate from "nudge was actionable".
            tw.write({
              traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
              type: 'pool:agentNudge', agentId: a.id, reason: 'settle_reject', message: action.message,
              tool: item.toolName, args: item.args,
            });
            const nudgeResult = { error: action.message };
            const nudgeTokens = buildToolResultDelta(ctx, JSON.stringify(nudgeResult), item.callId, { enableThinking: a.fmt.enableThinking });
            if (nudgeTokens.length <= stallHeadroom) {
              const probe = tools.get(item.toolName)?.probe(nudgeResult) ?? undefined;
              a.incrementTurns();
              resolved.push({
                rail: 'token',
                agentId: a.id,
                prefillTokens: nudgeTokens,
                toolName: item.toolName,
                callId: item.callId,
                args: item.args,
                probe,
              });
              stallHeadroom -= nudgeTokens.length;
              continue;
            }
            // Nudge doesn't fit — policy's suggestion is infeasible, fall through to drop.
          }

          // Drop. Reason: policy-said-idle OR nudge-didn't-fit →
          // `pressure_settle_reject` (policy path). Policy hook absent →
          // `settle_stall_break` (legacy fallback).
          const reason: 'pressure_settle_reject' | 'settle_stall_break' =
            action ? 'pressure_settle_reject' : 'settle_stall_break';
          tw.write({
            traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
            type: 'pool:agentDrop', agentId: a.id, reason,
          });
          // `agent:done` is one-shot. An already-`extracting` agent got here via the
          // critical-kill path, which ALREADY emitted `agent:done` at the kill; its
          // recovery turn deferred and re-surfaced at the stall-break. Re-announcing it
          // done would double-emit (violating the invariant `agent-pool.test.ts` asserts).
          if (!a.extracting) {
            traceAgentDone(tw, poolScopeId, a.id);
            yield* poolChannel.send({ type: 'agent:done', agentId: a.id });
          }
          if (policy.recoveryShape === 'parallel' && !a.extracting) {
            // In-loop (first attempt): queue the recovery turn for next tick's
            // SETTLE (alongside the surviving nudges). Agent is awaiting_tool → no
            // transition.
            const settled = yield* handleRecover(a, policy, ctx, pressureOpts, aliveCount, poolChannel, tw, poolScopeId);
            if (settled) resolved.push(settled);
          } else {
            // Staggered — OR a parallel agent ALREADY extracting whose recovery
            // turn couldn't fit headroom (reaching the stall-break with no active
            // siblings to free KV). Fall back to blocking recoverInline, which
            // extracts within the hardLimit reserve. BEFORE transition →
            // single-fiber store discipline. This is what prevents the
            // defer→stall→re-queue non-terminating loop when the turn never fits.
            yield* recoverInline(a, policy, ctx, store, tw, poolScopeId, poolChannel, pressureOpts, terminalGrammar, terminalToolName);
            a.transition('idle');
          }
        }

        // Replace deferred with the surviving (nudged) items for next tick.
        deferred.length = 0;
        deferred.push(...resolved);
      }

      // -- Phase 4: DISPATCH
      // Wind-down abandons parked retries: the drain reports with what agents
      // HAVE — waiting out infrastructure weather (a rate-limit park can be
      // 60–90s) to gather MORE evidence contradicts it, and the reap can't
      // touch an awaiting_tool agent until its park settles. Settle an honest
      // failure through the normal path instead; the agent turns active on
      // settle and the next tick's reap recovers its report. An agent
      // cancelled WHILE parked left its entry behind (it is idle/pruned) —
      // discarded here rather than re-executed.
      const abandoned: SettledTool[] = [];
      if (windingDown && pendingRetries.length > 0) {
        for (const r of pendingRetries.splice(0)) {
          if (r.agent.status !== 'awaiting_tool') continue;
          const result = { error:
            `${r.tc.name} is unavailable (rate-limited) and the run is winding down — ` +
            `report your findings with what you have.` };
          const resultStr = JSON.stringify(result);
          yield* poolChannel.send({ type: 'agent:tool_result', agentId: r.agent.id, tool: r.tc.name, result: resultStr });
          const prefillTokens = buildToolResultDelta(ctx, resultStr, r.callId, { enableThinking: r.agent.fmt.enableThinking });
          tw.write({ traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
            type: 'tool:result', agentId: r.agent.id, tool: r.tc.name,
            result, cells: prefillTokens.length, durationMs: 0 });
          abandoned.push({ rail: 'token', agentId: r.agent.id, prefillTokens, toolName: r.tc.name, callId: r.callId, args: r.tc.arguments, probe: undefined });
        }
      }
      // Due retries re-enter first — their agents have been parked since the
      // ToolRetryError and re-execute the same call (same callId, no counter
      // increments).
      const nowTs = performance.now();
      const dueRetries: typeof pendingRetries = [];
      for (let i = pendingRetries.length - 1; i >= 0; i--) {
        if (pendingRetries[i].notBefore <= nowTs) dueRetries.unshift(...pendingRetries.splice(i, 1));
      }
      const dispatched = yield* dispatch([
        ...dueRetries.map(r => ({ agent: r.agent, tc: r.tc, retryAttempt: r.attempt, retryCallId: r.callId })),
        ...toolCalls,
      ]);

      // Deferred + new dispatch results → next tick's SETTLE
      pendingSettled = [...deferred, ...dispatched, ...abandoned];

      // -- Termination + recovery
      // Wait for the orchestrator to finish before closing — it may spawn more agents.
      const allIdle = agents.every(a => a.status === 'idle' || a.status === 'disposed');
      // Don't exit while a fan-out tool is still in flight or a completion is
      // waiting to drain. An awaiting_tool agent already keeps allIdle false,
      // but this guards the edge where its agent was killed mid-flight.
      const fanoutQuiet = completedTools.length === 0 && inflightTasks.size === 0;
      if (allIdle && orchestratorDone && fanoutQuiet) {
        if (!recoveryAttempted) {
          recoveryAttempted = true;
          // Staggered leftovers reach here idle-without-result (killed by
          // max_turns / time / free_text_stop). `parallel` + wind-down already
          // recovered in-loop at each agent's stop (handleRecover), so this loop
          // is a no-op for them. One at a time → maximum per-report headroom
          // (the lossless path).
          for (const a of agents) {
            // A DISCARDED agent — user-cancelled or media-poisoned — is never
            // force-recovered, even when its branch could not be pruned
            // (non-leaf/recursed → safePrune no-op'd).
            if (a.status === 'idle' && !a.result && !a.branch.disposed && !discardedIds.has(a.id)) {
              yield* recoverInline(a, policy, ctx, store, tw, poolScopeId, poolChannel, pressureOpts, terminalGrammar, terminalToolName);
            }
          }
        }
        if (orchestratorError) throw orchestratorError;
        break;
      }
      if (allIdle && !orchestratorDone) {
        // All current agents done but orchestrator may spawn more.
        yield* sleep(1);
      }

      // All-parked: nothing active, nothing to settle/drain this tick — only
      // outstanding retries and/or in-flight fan-out tools. Without this the
      // loop busy-spins (parked agents are awaiting_tool, so the allIdle sleep
      // above never fires). Cap the nap at 50ms so orchestrator spawns/extends
      // are picked up promptly; wake early when a fan-out tool completes.
      if (
        (pendingRetries.length > 0 || inflightTasks.size > 0)
        && pendingSettled.length === 0
        && completedTools.length === 0
        && pendingSpawns.length === 0
        && pendingExtends.length === 0
        && !agents.some(a => a.status === 'active')
      ) {
        const nextDue = pendingRetries.length > 0
          ? Math.min(...pendingRetries.map(r => r.notBefore))
          : performance.now() + 50;
        const nap = Math.max(1, Math.min(50, nextDue - performance.now()));
        if (inflightTasks.size > 0) {
          yield* race([sleep(nap), awaitToolCompletion()]);
        } else {
          yield* sleep(nap);
        }
      }
    }

    // ── Close channel with result — consumers get AgentPoolResult as close value ───────
    // Branch cleanup is handled by each branch's ensure() from setupAgent —
    // when this resource's scope exits, all ensure() callbacks fire.
    tw.write({
      traceId: tw.nextId(), parentTraceId: poolScopeId, ts: performance.now(),
      type: 'pool:close',
      agents: agents.map(a => ({
        agentId: a.id, tokenCount: a.tokenCount,
        toolCallCount: a.toolCallCount, result: a.result,
        // Disposed → the pre-prune harvest (0 only if the branch died outside
        // the pool's prune paths — scope teardown mid-run).
        ppl: a.branch.disposed ? (a.finalPpl ?? 0) : a.branch.perplexity,
      })),
      totalTokens: agents.reduce((s, a) => s + a.tokenCount, 0),
      steps, durationMs: performance.now() - poolT0,
    });

    const result: AgentPoolResult = {
      agents: agents.map(a => ({
          agentId: a.id,
          parentAgentId: a.parentId,
          branch: a.branch,
          agent: a,
          result: a.result,
          exitReason: a.exitReason,
          toolCallCount: a.toolCallCount,
          tokenCount: a.tokenCount,
          ppl: a.branch.disposed ? (a.finalPpl ?? 0) : a.branch.perplexity,
          samplingPpl: a.branch.disposed ? (a.finalSamplingPpl ?? 0) : a.branch.samplingPerplexity,
          trace: trace ? a.traceBuffer : undefined,
          nestedResults: [...a.nestedResults],
        })),
      totalTokens: agents.reduce((s, a) => s + a.tokenCount, 0),
      totalToolCalls,
      steps,
      counters,
    };

    yield* poolChannel.close(result);

      } catch {
        // KV exhaustion or other decode failure — close with partial results
        const partial: AgentPoolResult = {
          agents: agents.map(a => ({
            agentId: a.id, parentAgentId: a.parentId, branch: a.branch, agent: a,
            result: a.result, exitReason: a.exitReason, toolCallCount: a.toolCallCount, tokenCount: a.tokenCount,
            ppl: a.branch.disposed ? (a.finalPpl ?? 0) : a.branch.perplexity,
            samplingPpl: a.branch.disposed ? (a.finalSamplingPpl ?? 0) : a.branch.samplingPerplexity,
            trace: trace ? a.traceBuffer : undefined,
            nestedResults: [...a.nestedResults],
          })),
          totalTokens: agents.reduce((s, a) => s + a.tokenCount, 0),
          totalToolCalls, steps, counters,
        };
        yield* poolChannel.close(partial);
      }

    }); // end spawn — tick loop

    yield* provide(subscription);
  });
}
