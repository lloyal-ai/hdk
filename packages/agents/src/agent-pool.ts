import { resource, call, ensure, createSignal, createChannel, spawn, scoped, each, sleep, action, race } from 'effection';
import type { Operation, Subscription, Task } from 'effection';
import type { Branch } from '@lloyal-labs/sdk';
import { CHAT_FORMAT_CONTENT_ONLY, CHAT_FORMAT_GENERIC, GrammarTriggerType, type ParsedToolCall, type SessionContext } from '@lloyal-labs/sdk';
import type { BranchStore } from '@lloyal-labs/sdk';
import { Ctx, Store, Trace, TraceParent, CallingAgent, SpineFmt, GrantStoreCtx } from './context';
import type { FormatConfig } from './Agent';
import { buildToolResultDelta, buildTurnDelta } from '@lloyal-labs/sdk';
import { traceScope } from './trace-scope';
import type { TraceWriter } from './trace-writer';
import type { AgentPolicy, IdleReason, ToolRetryAction } from './AgentPolicy';
import { Agent } from './Agent';
import { DefaultAgentPolicy, tokenBudgetAsWords, RECOVERY_PREFILL_OVERHEAD, BATCH_BUFFER } from './AgentPolicy';
import type { PolicyConfig } from './AgentPolicy';
import { Tool, ToolRetryError } from './Tool';
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

/** Minimal event sender interface — accepts any Channel close type */
type EventSender = { send(value: AgentEvent): Operation<void> };

interface SettledTool {
  agentId: number;
  prefillTokens: number[];
  toolName: string;
  callId: string;
  args: string;
  probe?: string;
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

  /** Total KV cache capacity (max positions). 0 when no context limit. */
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

/** Eager `{ result: string }` extraction grammar — constrains recovery output
 *  from token 0. Shared by `recoverInline` (uncapped) and the parallel fold.
 *
 *  `maxChars` (when set) caps the `result` string via JSON-Schema `maxLength` —
 *  the binding emits `char{0,N}` and forces the closing quote, so the report is
 *  hard-bounded AND the JSON always parses. Used by the parallel fold to fit N
 *  concurrent reports in shared KV; staggered passes none (full-length reports). */
function* recoveryReportGrammar(ctx: SessionContext, maxChars?: number): Operation<string> {
  return yield* call(() =>
    ctx.jsonSchemaToGrammar(JSON.stringify({
      type: 'object',
      properties: {
        result: maxChars != null
          ? { type: 'string', maxLength: maxChars }
          : { type: 'string' },
      },
      required: ['result'],
    })),
  );
}

/** Tokenize the recovery prompt (the `onRecovery` system+user turn) into a
 *  branch-prefill delta appended to the agent's existing conversation KV.
 *  Shared by both reap shapes. */
function recoveryPromptTokens(
  ctx: SessionContext,
  recovery: { prompt: { system: string; user: string } },
): number[] {
  const { prompt } = ctx.formatChatSync(
    JSON.stringify([
      { role: 'system', content: recovery.prompt.system },
      { role: 'user', content: recovery.prompt.user },
    ]), { enableThinking: false },
  );
  return [...ctx.getTurnSeparator(), ...ctx.tokenizeSync(prompt, false)];
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
): Operation<boolean> {
  tw.write({
    traceId: tw.nextId(), parentTraceId, ts: performance.now(),
    type: 'pool:recoveryProduce', agentId: agent.id,
    tokenCount: producedTokens, outputLength: output.length,
  });
  let failureReason: string | null = null;
  try {
    const parsed = JSON.parse(output) as { result: string };
    if (parsed?.result) {
      agent.setResult(stripDanglingToolCall(parsed.result), 'recovery');
      yield* events.send({ type: 'agent:recovered', agentId: agent.id, result: agent.result! });
      tw.write({
        traceId: tw.nextId(), parentTraceId, ts: performance.now(),
        type: 'pool:recoveryReturn', agentId: agent.id,
        resultLength: parsed.result.length,
      });
      return true;
    }
    failureReason = 'no_result_field';
  } catch (e) {
    failureReason = `parse_error: ${(e as Error).message ?? 'unknown'}`;
  }
  tw.write({
    traceId: tw.nextId(), parentTraceId, ts: performance.now(),
    type: 'pool:recoveryFailed', agentId: agent.id,
    reason: failureReason ?? 'unknown',
    outputExcerpt: output.slice(0, 200),
  });
  return false;
}

/**
 * Inline recovery for a single killed agent (trailing stop).
 *
 * Prefills the extraction prompt into the agent's own branch, sets eager
 * report grammar, generates to stop token, parses JSON, reports result,
 * and prunes the branch — all before the tick loop continues. The freed
 * KV lets remaining agents keep researching.
 *
 * Returns true if the agent reported findings.
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
): Operation<boolean> {
  // Fresh snapshot — the policy uses this to compute the recovery budget
  // (reflected in the rendered prompt via `<%= it.budget %>`).
  const recovery = policy.onRecovery?.(agent, new ContextPressure(ctx, pressureOpts));
  if (!recovery || recovery.type === 'skip') {
    if (!agent.branch.disposed) agent.branch.pruneSync();
    return false;
  }

  const tokens = recoveryPromptTokens(ctx, recovery);
  const reportGrammar = yield* recoveryReportGrammar(ctx);

  // Recovery runs in its own scope — if prefill or decode fails (KV
  // exhaustion), the scope tears down cleanly. The recoveryProduce/Return/
  // Failed traces make silent recovery failures observable.
  let reported = false;
  let output = '';
  let producedTokens = 0;
  try {
    yield* scoped(function*() {
      yield* call(() => store.prefill([[agent.branch, tokens]]));
      agent.branch.setGrammar(reportGrammar);

      tw.write({
        traceId: tw.nextId(), parentTraceId, ts: performance.now(),
        type: 'branch:prefill', branchHandle: agent.id,
        tokenCount: tokens.length, role: 'recovery',
      });

      // Single-agent produce/commit loop
      for (;;) {
        const { token, text, isStop } = agent.branch.produceSync();
        if (isStop) break;
        output += text;
        producedTokens++;
        yield* call(() => store.commit([[agent.branch, token]]));
        yield* events.send({ type: 'agent:produce', agentId: agent.id, text, tokenCount: producedTokens });
      }

      reported = yield* finishRecovery(agent, output, producedTokens, events, tw, parentTraceId);
    });
  } catch (e) {
    // Scope teardown (KV exhaustion during prefill/decode) — finishRecovery
    // never ran, so emit the failure trace here.
    tw.write({
      traceId: tw.nextId(), parentTraceId, ts: performance.now(),
      type: 'pool:recoveryFailed', agentId: agent.id,
      reason: `scope_error: ${(e as Error).message ?? 'unknown'}`,
      outputExcerpt: output.slice(0, 200),
    });
  }

  // Always prune after scope exits (success or failure)
  if (!agent.branch.disposed) agent.branch.pruneSync();

  // Emit tick so TUI updates pressure percentage after prune
  const postPressure = new ContextPressure(ctx);
  yield* events.send({ type: 'agent:tick', cellsUsed: postPressure.cellsUsed, nCtx: postPressure.nCtx });

  return reported;
}

// Per-report budget bounds (tokens) for the headroom-derived fold budget, used
// when no fixed `policy.reportBudget` is set (e.g. wind-down). MIN keeps a report
// usable; MAX stops an ample-KV wind-down from writing essays.
const MIN_REPORT_BUDGET = 128;
const MAX_REPORT_BUDGET = 2048;

/** Prune a finished recovery branch, skipping it if it still has live children —
 *  `pruneSync` throws on children (RESTRICT mode), which a delegate parent could
 *  hit (a sub-agent forks off the calling agent's branch). A skipped parent's KV
 *  is reclaimed at pool teardown; in practice delegate sub-pools complete + prune
 *  before the termination sweep, so this guard rarely fires. */
function safePrune(branch: Branch): void {
  if (!branch.disposed && branch.children.length === 0) branch.pruneSync();
}

/** Recover one fold group in a single batched pass: one `store.prefill` of every
 *  prompt, then a batched decode (one `store.commit` per step across all live
 *  branches — MOAT #1), extract on stop, then `safePrune` each (freeing KV for the
 *  next group). The grammar is `maxLength`-capped so the group fits the budget the
 *  fold reserved for it. Runs on the loop fiber inside a scope so a mid-batch KV
 *  exhaustion tears down cleanly. Returns how many agents reported. */
function* recoverGroup(
  group: Agent[],
  groupTokens: number[][],
  reportGrammar: string,
  store: BranchStore,
  tw: TraceWriter,
  parentTraceId: number,
  events: EventSender,
): Operation<number> {
  const prefillPairs: [Branch, number[]][] = group.map((a, i) => [a.branch, groupTokens[i]]);
  const output = new Map<Agent, string>();
  const produced = new Map<Agent, number>();
  const done = new Set<Agent>();
  for (const agent of group) { output.set(agent, ''); produced.set(agent, 0); }

  let reported = 0;
  try {
    yield* scoped(function*() {
      // One batched prefill of every extraction prompt, then per-branch grammar.
      yield* call(() => store.prefill(prefillPairs));
      for (let i = 0; i < group.length; i++) {
        group[i].branch.setGrammar(reportGrammar);
        tw.write({
          traceId: tw.nextId(), parentTraceId, ts: performance.now(),
          type: 'branch:prefill', branchHandle: group[i].id,
          tokenCount: groupTokens[i].length, role: 'recovery',
        });
      }

      // Batched produce/commit — one `store.commit` per step (which packs all
      // branches into a single llama_decode internally — MOAT #1). A stop drops
      // that agent from the group and extracts its report.
      while (done.size < group.length) {
        const entries: [Branch, number][] = [];
        for (const agent of group) {
          if (done.has(agent)) continue;
          const { token, text, isStop } = agent.branch.produceSync();
          if (isStop) {
            done.add(agent);
            if (yield* finishRecovery(agent, output.get(agent)!, produced.get(agent)!, events, tw, parentTraceId)) {
              reported++;
            }
            continue;
          }
          output.set(agent, output.get(agent)! + text);
          produced.set(agent, produced.get(agent)! + 1);
          entries.push([agent.branch, token]);
          yield* events.send({ type: 'agent:produce', agentId: agent.id, text, tokenCount: produced.get(agent)! });
        }
        if (entries.length === 0) break;
        yield* call(() => store.commit(entries));
      }
    });
  } catch (e) {
    // KV exhaustion mid-batch — mark every agent that hadn't finished failed.
    const reason = `scope_error: ${(e as Error).message ?? 'unknown'}`;
    for (const agent of group) {
      if (done.has(agent)) continue;
      tw.write({
        traceId: tw.nextId(), parentTraceId, ts: performance.now(),
        type: 'pool:recoveryFailed', agentId: agent.id,
        reason, outputExcerpt: output.get(agent)!.slice(0, 200),
      });
    }
  }

  for (const agent of group) safePrune(agent.branch);
  return reported;
}

/**
 * Parallel recovery — extract reports from the whole idle/unreported cohort as a
 * bounded FOLD. Each step recovers the largest group that fits in current KV at a
 * fixed per-report budget `b`, then prunes it (freeing KV) and recurses over the
 * rest. The group size `k` flexes 1..N with available headroom — k=N (one batched
 * pass) when KV is ample, k=1 (effectively staggered) when it's tight — and grows
 * again as pruning replenishes KV. The partition IS the decision: no mode flag.
 *
 * `b` (tokens) is FIXED for the fold: `policy.reportBudget` when set (the configured
 * cap, e.g. low effort), else a fair share of current headroom computed once. It
 * bounds each report two ways — rendered into the recovery prompt as the advisory
 * word count (via the `onRecovery` budget override) AND enforced as the grammar
 * `maxLength` cap (the hard backstop). This is what fixes the pool-wide-budget bug:
 * every agent is told `b`, not the whole KV, so N concurrent reports can't
 * collectively exhaust it.
 *
 * Like `recoverInline`, this MUST run entirely on the loop fiber and finish before
 * any agent transitions to 'idle' / the orchestrator wakes — a concurrent native
 * call on the shared llama_context would SEGV.
 *
 * Returns the number of agents that reported.
 */
function* recoverParallel(
  cohort: Agent[],
  policy: AgentPolicy,
  ctx: SessionContext,
  store: BranchStore,
  tw: TraceWriter,
  parentTraceId: number,
  events: EventSender,
  pressureOpts: PressureThresholds,
): Operation<number> {
  // Eligibility pass: keep idle, unreported, undisposed agents the policy opts to
  // recover; skip-prune the rest now (frees their KV for the fold). The prompt from
  // this probe is discarded — the fold re-renders each prompt with the fixed `b`.
  const queue: Agent[] = [];
  for (const agent of cohort) {
    if (agent.status !== 'idle' || agent.result || agent.branch.disposed) continue;
    const probe = policy.onRecovery?.(agent, new ContextPressure(ctx, pressureOpts));
    if (!probe || probe.type === 'skip') {
      safePrune(agent.branch);
      continue;
    }
    queue.push(agent);
  }
  if (queue.length === 0) return 0;

  // Fixed per-report budget `b` (tokens): the configured cap, else a fair share of
  // current headroom, computed ONCE. RESERVE matches `onRecovery`'s own accounting.
  const RESERVE = RECOVERY_PREFILL_OVERHEAD + BATCH_BUFFER;
  const remaining0 = new ContextPressure(ctx, pressureOpts).remaining;
  const b = policy.reportBudget
    ?? Math.min(MAX_REPORT_BUDGET, Math.max(MIN_REPORT_BUDGET, Math.floor((remaining0 - RESERVE) / queue.length)));
  // Grammar cap is in CHARS, `b` is in tokens: words(b) × ~6 chars × 1.2 headroom,
  // so the model concludes within `b` on its own and the cap is a silent backstop.
  const bChars = Math.ceil(tokenBudgetAsWords(b) * 6 * 1.2);
  const reportGrammar = yield* recoveryReportGrammar(ctx, bChars);

  // Render + tokenize every recovery prompt ONCE at the fixed budget `b` — the
  // prompt is identical across groups since `b` is fixed, so a boundary agent is
  // never re-rendered/re-tokenized. This pass re-runs onRecovery only to bind `b`
  // into the prompt; its skip is budget-independent (decided before the budget
  // calc, on agent state unchanged since the eligibility probe), so it drops no one
  // the probe kept and `b` stays the true fair share over `queue.length`. (A custom
  // policy that DID skip here would only under-budget — shorter reports — never
  // over-budget/exhaust.)
  const entries: { agent: Agent; tokens: number[] }[] = [];
  for (const agent of queue) {
    const recovery = policy.onRecovery!(agent, new ContextPressure(ctx, pressureOpts), b);
    if (!recovery || recovery.type === 'skip') { safePrune(agent.branch); continue; }
    entries.push({ agent, tokens: recoveryPromptTokens(ctx, recovery) });
  }

  // The fold: pack the largest prefix that fits at (promptTokens + b) per report
  // into each group (always ≥ 1), recover it, prune (replenishes KV), re-read
  // headroom, recurse over the rest. `k` flexes 1..N; the partition IS the decision.
  let reported = 0;
  let i = 0;
  while (i < entries.length) {
    const budget = new ContextPressure(ctx, pressureOpts).remaining - RESERVE;
    const group: Agent[] = [];
    const groupTokens: number[][] = [];
    let used = 0;
    while (i < entries.length) {
      const cost = entries[i].tokens.length + b;
      if (group.length > 0 && used + cost > budget) break; // group full — recover it, prune, re-read KV
      group.push(entries[i].agent);
      groupTokens.push(entries[i].tokens);
      used += cost;
      i++;
    }
    reported += yield* recoverGroup(group, groupTokens, reportGrammar, store, tw, parentTraceId, events);
  }

  // Emit tick so TUI updates pressure percentage after the final prune.
  const postPressure = new ContextPressure(ctx);
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

function* handleFreeTextReturn(
  a: Agent, content: string, events: EventSender,
): Operation<void> {
  a.setResult(stripDanglingToolCall(content), 'free_text');
  a.transition('idle');
  yield* events.send({ type: 'agent:return', agentId: a.id, result: a.result! });
  yield* events.send({ type: 'agent:done', agentId: a.id });
}

function* handleIdleDrop(
  a: Agent, reason: IdleReason, events: EventSender,
  tw: TraceWriter, parentTraceId: number,
): Operation<void> {
  a.transition('idle');
  if (reason !== 'free_text_stop') {
    tw.write({ traceId: tw.nextId(), parentTraceId, ts: performance.now(),
      type: 'pool:agentDrop', agentId: a.id,
      reason: reason === 'max_turns' ? 'maxTurns' : 'pressure_softcut' });
  }
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
  return { agentId: a.id, prefillTokens, toolName: tc?.name || '', callId, args: tc?.arguments || '', probe };
}

function* handleReturn(
  a: Agent, result: string, tc: ParsedToolCall, terminalToolName: string,
  pruneOnReturn: boolean, events: EventSender,
): Operation<void> {
  a.setResult(stripDanglingToolCall(result), 'voluntary_return');
  a.transition('idle');
  a.incrementToolCalls();
  yield* events.send({ type: 'agent:tool_call', agentId: a.id, tool: terminalToolName, args: tc.arguments });
  yield* events.send({ type: 'agent:return', agentId: a.id, result: a.result! });
  yield* events.send({ type: 'agent:done', agentId: a.id });
  if (pruneOnReturn && !a.branch.disposed) a.branch.pruneSync();
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

  // The spawn's app membership is now a non-enforcing label:
  // the authGuard gates tools by `Tool.protected` + session grants at the
  // pool level, not by app-scoped allow-lists. The label is carried for
  // trace attribution (`tool:authReject`) and harness UI only.
  const assignedApp: string | null = task.assignedApp ?? null;

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
    assignedApp,
  });

  return { agent, suffixTokens, formattedPrompt: fmt.prompt };
}

/**
 * Concurrent agent generation loop as an Effection resource
 *
 * Runs N agents in parallel using a four-phase tick loop over shared
 * {@link BranchStore} infrastructure. Each agent forks from a parent
 * branch, generates tokens, invokes tools, and reports findings.
 *
 * **Four-phase tick loop:**
 * 1. **PRODUCE** — sample all active agents via `produceSync()` (no async gap)
 * 2. **COMMIT** — single GPU call via `store.commit()` for all produced tokens
 * 3. **SETTLE** — drain settled tool results, batch prefill, reset grammars
 * 4. **DISPATCH** — execute collected tool calls sequentially via `scoped()` + `call()`
 *
 * Tool dispatch uses `scoped()` + `call()` — each tool executes to completion
 * before the next tick, ensuring exclusive `llama_context` access (no concurrent decode).
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
    const { spine, orchestrate, toolsJson, tools, maxTurns = 100, terminalToolName, trace = false, pruneOnReturn = false, enableThinking = true, eagerGrammar } = opts;

    // Tool index map for trace — position in toolkit array
    const toolIndexMap = new Map([...tools.keys()].map((name, i) => [name, i]));
    const toolkitSize = tools.size;

    const poolT0 = performance.now();
    let poolParentTraceId: number | null = null;
    try { const p = yield* TraceParent.get(); if (p != null) poolParentTraceId = p; } catch { /* top level */ }
    const poolScope = traceScope(tw, poolParentTraceId, 'pool', { maxTurns, terminalToolName });

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
    const policy = opts.policy ?? new DefaultAgentPolicy();
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

    // Pool-level branch cleanup — ensures orphan-branch cleanup even when
    // spawns are lazy and the orchestrator's spawn scope exits early.
    yield* ensure(() => {
      for (const a of agents) {
        if (!a.branch.disposed) a.branch.pruneSync();
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
      traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
      type: 'pool:open', agentCount: 0, taskSuffixTokens: [],
      pressure: (() => {
        const p = new ContextPressure(ctx, pressureOpts);
        return { remaining: p.remaining, softLimit: p.softLimit, headroom: p.headroom };
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
          parent,
          assignedApp: spec.assignedApp,
        };

        // Synchronous setup — fork, tokenize suffix, pressure check.
        // No native store call yet; that's the tick loop's SPAWN phase's job.
        const { agent, suffixTokens, formattedPrompt } = yield* setupAgent(parent, task, ctx, enableThinking);

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
            traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
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
    yield* spawn(function*() {
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

      const prefillPairs: [Branch, number[]][] = [];
      const settledAgents: Agent[] = [];
      const settledOrder: { agentId: number; callId: string; tokenCount: number }[] = [];
      const itemProbes = new Map<number, string | undefined>();
      const deferred: SettledTool[] = [];

      for (const item of items) {
        const a = agentById.get(item.agentId);
        if (!a || a.status === 'idle') continue;

        if (item.prefillTokens.length > headroom) {
          // Defer — siblings may finish and free KV, letting this result
          // settle next tick (staggered-exit for parallel orchestration).
          // Policy is consulted at stall-break time, not here: invoking
          // it eagerly would break "wait for a sibling to report and
          // free cells" by nudging/dropping on first over-headroom.
          deferred.push(item);
          continue;
        }

        prefillPairs.push([a.branch, item.prefillTokens]);
        settledAgents.push(a);
        settledOrder.push({ agentId: a.id, callId: item.callId, tokenCount: item.prefillTokens.length });
        if (item.probe) itemProbes.set(a.id, item.probe);
        headroom -= item.prefillTokens.length;
        const postSettle = new ContextPressure(ctx, pressureOpts);
        a.recordToolResult({
          name: item.toolName, args: item.args,
          resultTokenCount: item.prefillTokens.length,
          contextAfterPercent: postSettle.percentAvailable,
          timestamp: performance.now(),
        });
        tw.write({ traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
          type: 'branch:prefill', branchHandle: a.id,
          tokenCount: item.prefillTokens.length, role: 'toolResult' });
      }

      if (prefillPairs.length > 0) {
        yield* call(() => store.prefill(prefillPairs));
        counters.warmPrefillCalls++;
        counters.warmPrefillBranches += prefillPairs.length;

        // Fan-out determinism: record the canonical scatter order so the replay
        // settle-order oracle can reproduce this exact interleaving. On the
        // serial path this equals dispatch order; the event is emitted uniformly.
        tw.write({ traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
          type: 'tool:settle_order', batch: settledOrder });

        // Probe prefill from DISPATCH or nudge-replacement.
        const probePairs: [Branch, number[]][] = [];
        for (const a of settledAgents) {
          const probe = itemProbes.get(a.id);
          if (probe) {
            const probeTokens = ctx.tokenizeSync(probe, false);
            probePairs.push([a.branch, probeTokens]);
            tw.write({ traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
              type: 'branch:prefill', branchHandle: a.id,
              tokenCount: probeTokens.length, role: 'probe', probeText: probe });
          }
        }
        if (probePairs.length > 0) {
          yield* call(() => store.prefill(probePairs));
        }

        for (const a of settledAgents) {
          a.transition('active');
          a.resetTurn();
          applyLazyGrammar(a);
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

    /** Post-process one tool completion ON THE LOOP FIBER: tokenize the result,
     *  send events, write traces, and return a SettledTool to prefill — or null
     *  for a retry-park / error-kill. Shared by the inline path (called inline)
     *  and DRAIN (called when a fan-out child's completion arrives). The body is
     *  the relocated post-tool logic; relocating it onto the loop fiber is what
     *  keeps the main-context tokenize/reads off the child fibers. */
    function* processCompletion(c: ToolCompletion): Operation<SettledTool | null> {
      const { agent, tc, callId, dispatchTraceId } = c;

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
          result: exhausted, prefillTokenCount: prefillTokens.length,
          durationMs: performance.now() - c.toolT0 });
        return { agentId: agent.id, prefillTokens, toolName: tc.name, callId, args: tc.arguments, probe: undefined };
      }

      // c.kind === 'result'
      const result = c.result;
      const tool = tools.get(tc.name);
      const postToolPressure = new ContextPressure(ctx, pressureOpts);
      const contextAvailablePercent = postToolPressure.percentAvailable;
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        (result as Record<string, unknown>)._contextAvailablePercent = contextAvailablePercent;
        const resultObj = result as Record<string, unknown>;
        if (Array.isArray(resultObj.results)) {
          agent.addNestedResults((resultObj.results as unknown[]).filter((f): f is string => typeof f === 'string'));
        }
        if (Array.isArray(resultObj.nestedResults)) {
          agent.addNestedResults((resultObj.nestedResults as unknown[]).filter((f): f is string => typeof f === 'string'));
        }
      }
      const resultStr = JSON.stringify(result);
      yield* poolChannel.send({ type: 'agent:tool_result', agentId: agent.id, tool: tc.name, result: resultStr, contextAvailablePercent });
      const prefillTokens = buildToolResultDelta(ctx, resultStr, callId, { enableThinking: agent.fmt.enableThinking });
      const probe = tool?.probe(result) ?? undefined;
      tw.write({ traceId: tw.nextId(), parentTraceId: dispatchTraceId, ts: performance.now(),
        type: 'tool:result', agentId: agent.id, tool: tc.name,
        result, prefillTokenCount: prefillTokens.length,
        durationMs: performance.now() - c.toolT0 });
      return { agentId: agent.id, prefillTokens, toolName: tc.name, callId, args: tc.arguments, probe };
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
          traceId: dispatchTraceId, parentTraceId: poolScope.traceId, ts: toolT0,
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
        const settled = yield* processCompletion(completion);
        if (settled) results.push(settled);
      }

      return results;
    }

    // ── Four-phase tick loop ─────────────────────────────────
    let pendingSettled: SettledTool[] = [];

    // ── Four-phase tick loop ─────────────────────────────────
    let recoveryAttempted = false;
    for (;;) {
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
      if (pendingSpawns.length > 0 || pendingExtends.length > 0) {
        const drainedSpawns = pendingSpawns.splice(0, pendingSpawns.length);
        const drainedExtends = pendingExtends
          .splice(0, pendingExtends.length)
          .filter(e => !e.discarded);

        const prefillPairs: [Branch, number[]][] = [
          ...drainedSpawns.map(s => [s.agent.branch, s.suffixTokens] as [Branch, number[]]),
          ...drainedExtends.map(e => [spine, e.tokens] as [Branch, number[]]),
        ];

        try {
          if (prefillPairs.length > 0) {
            yield* call(() => store.prefill(prefillPairs));
          }
        } catch (err) {
          for (const e of drainedExtends) e.reject(err as Error);
          throw err;
        }

        // Resolve extend requests with the delta token count. spine.position
        // has advanced by the sum of extend token counts at this point.
        for (const e of drainedExtends) {
          tw.write({
            traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
            type: 'spine:extend',
            userContent: e.userContent,
            assistantContent: e.assistantContent,
            deltaTokens: e.tokens.length,
            positionAfter: spine.position,
          });
          e.resolve(e.tokens.length);
        }

        for (const s of drainedSpawns) {
          tw.write({
            traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
            type: 'branch:create', branchHandle: s.agent.id, parentHandle: s.agent.parentId,
            position: s.agent.forkHead, role: 'agentFork',
          });
          tw.write({
            traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
            type: 'prompt:format', promptText: s.formattedPrompt,
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
          yield* poolChannel.send({ type: 'agent:spawn', agentId: s.agent.id, parentAgentId: s.agent.parentId });
        }
      }

      // If all we had was pending spawns, and none of them activated (shouldn't happen
      // normally — SPAWN always transitions to active), nothing to produce. Loop back.
      if (agents.length === 0) continue;

      // -- Phase 1: PRODUCE -- sample from active agents, collect tool calls
      policy.resetTick?.();
      const pressure = new ContextPressure(ctx, pressureOpts);

      const entries: [Branch, number][] = [];
      const toolCalls: { agent: Agent; tc: ParsedToolCall }[] = [];
      const nudges: SettledTool[] = [];

      for (const a of agents) {
        if (a.status !== 'active') continue;

        const policyExit = policy.shouldExit?.(a, pressure);
        if (policyExit ?? pressure.critical) {
          const exitReason = pressure.critical ? 'pressure_critical' as const
            : policyExit ? 'policy_exit' as const
            : 'pressure_critical' as const;
          tw.write({ traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
            type: 'pool:agentDrop', agentId: a.id, reason: exitReason });
          yield* poolChannel.send({ type: 'agent:done', agentId: a.id });
          // Run recovery BEFORE transitioning to idle — otherwise the statusSignal
          // fires 'idle' mid-recovery, PoolContext.waitFor returns early, the
          // orchestrator resumes and starts spawning/prefilling the next task
          // while this agent is still being decoded by recoverInline. Concurrent
          // native calls on the same llama_context → SEGV.
          yield* recoverInline(a, policy, ctx, store, tw, poolScope.traceId, poolChannel, pressureOpts);
          a.transition('idle');
          continue;
        }

        const { token, text, isStop } = a.branch.produceSync();
        if (isStop) {
          const parsed = a.finalize(ctx);

          tw.write({
            traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
            type: 'agent:turn', agentId: a.id, turn: a.turns,
            rawOutput: a.rawOutput,
            parsedContent: parsed.content || null,
            parsedToolCalls: parsed.toolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments })),
          });

          // Policy decides what to do with the parsed output
          const action = policy.onProduced(a, parsed, pressure, policyConfig);

          switch (action.type) {
            case 'free_text_return':
              yield* handleFreeTextReturn(a, action.content, poolChannel);
              continue;
            case 'idle':
              yield* handleIdleDrop(a, action.reason, poolChannel, tw, poolScope.traceId);
              continue;
            case 'nudge':
              // authGuard rejection: emit the structured
              // tool:authReject event BEFORE the generic agentNudge so a
              // single trace pass captures attribution + rejection context.
              if (action.guard === 'auth_reject') {
                tw.write({
                  traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
                  type: 'tool:authReject',
                  agentId: a.id,
                  assignedApp: a.assignedApp,
                  attemptedTool: parsed.toolCalls[0].name,
                  lineageHistory: a.walkAncestors((x) => x.toolHistory),
                });
              }
              nudges.push(yield* handleNudge(a, action.message, parsed.toolCalls[0], ctx, tools));
              tw.write({ traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
                type: 'pool:agentNudge', agentId: a.id, reason: 'nudge', message: action.message });
              continue;
            case 'return':
              yield* handleReturn(a, action.result, parsed.toolCalls[0], terminalToolName!, pruneOnReturn, poolChannel);
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
        yield* call(() => store.commit(entries));
        steps++;
        const commitPressure = new ContextPressure(ctx, pressureOpts);
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
          const settled = yield* processCompletion(c);
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

          const action = policy.onSettleReject?.(a, item.prefillTokens.length, stallPressure, policyConfig);

          if (action?.type === 'nudge') {
            // Record the policy's decision regardless of whether the
            // nudge itself fits — the event captures "policy consulted,
            // returned nudge" which is separate from "nudge was actionable".
            tw.write({
              traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
              type: 'pool:agentNudge', agentId: a.id, reason: 'settle_reject', message: action.message,
            });
            const nudgeResult = { error: action.message };
            const nudgeTokens = buildToolResultDelta(ctx, JSON.stringify(nudgeResult), item.callId, { enableThinking: a.fmt.enableThinking });
            if (nudgeTokens.length <= stallHeadroom) {
              const probe = tools.get(item.toolName)?.probe(nudgeResult) ?? undefined;
              a.incrementTurns();
              resolved.push({
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
            traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
            type: 'pool:agentDrop', agentId: a.id, reason,
          });
          yield* poolChannel.send({ type: 'agent:done', agentId: a.id });
          // Recover BEFORE transition — single-fiber store discipline.
          yield* recoverInline(a, policy, ctx, store, tw, poolScope.traceId, poolChannel, pressureOpts);
          a.transition('idle');
        }

        // Replace deferred with the surviving (nudged) items for next tick.
        deferred.length = 0;
        deferred.push(...resolved);
      }

      // -- Phase 4: DISPATCH
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
      pendingSettled = [...deferred, ...dispatched];

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
          // Recover any idle agents that weren't handled by inline recovery
          // (e.g., killed by max_turns, time budget, or free_text_stop).
          // `parallel` batches the whole cohort (one prefill + batched decode —
          // wall-clock ≈ the slowest single report); `staggered` (default)
          // recovers them one at a time for maximum per-report headroom.
          if (policy.recoveryShape === 'parallel') {
            yield* recoverParallel(agents, policy, ctx, store, tw, poolScope.traceId, poolChannel, pressureOpts);
          } else {
            for (const a of agents) {
              if (a.status === 'idle' && !a.result && !a.branch.disposed) {
                yield* recoverInline(a, policy, ctx, store, tw, poolScope.traceId, poolChannel, pressureOpts);
              }
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
      traceId: tw.nextId(), parentTraceId: poolScope.traceId, ts: performance.now(),
      type: 'pool:close',
      agents: agents.map(a => ({
        agentId: a.id, tokenCount: a.tokenCount,
        toolCallCount: a.toolCallCount, result: a.result,
        ppl: a.branch.disposed ? 0 : a.branch.perplexity,
      })),
      totalTokens: agents.reduce((s, a) => s + a.tokenCount, 0),
      steps, durationMs: performance.now() - poolT0,
    });
    poolScope.close();

    const result: AgentPoolResult = {
      agents: agents.map(a => ({
          agentId: a.id,
          parentAgentId: a.parentId,
          branch: a.branch,
          agent: a,
          result: a.result,
          toolCallCount: a.toolCallCount,
          tokenCount: a.tokenCount,
          ppl: a.branch.disposed ? 0 : a.branch.perplexity,
          samplingPpl: a.branch.disposed ? 0 : a.branch.samplingPerplexity,
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
        poolScope.close();
        const partial: AgentPoolResult = {
          agents: agents.map(a => ({
            agentId: a.id, parentAgentId: a.parentId, branch: a.branch, agent: a,
            result: a.result, toolCallCount: a.toolCallCount, tokenCount: a.tokenCount,
            ppl: a.branch.disposed ? 0 : a.branch.perplexity,
            samplingPpl: a.branch.disposed ? 0 : a.branch.samplingPerplexity,
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
