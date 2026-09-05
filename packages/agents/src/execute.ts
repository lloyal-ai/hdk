import { call, ensure, spawn, scoped, action } from 'effection';
import type { Operation, Task, Signal } from 'effection';
import type { Branch, BranchStore, SessionContext, ParsedToolCall, MultimodalDelta } from '@lloyal-labs/sdk';
import {
  CHAT_FORMAT_CONTENT_ONLY, CHAT_FORMAT_GENERIC, GrammarTriggerType,
  buildToolResultDelta, buildToolResultDeltaMultimodal, decodeErrorOf, deltaCells,
} from '@lloyal-labs/sdk';
import type { Attachment, AttachmentStore, ContentIngress } from '@lloyal-labs/media';
import { waitUntilSettled } from './combinators';
import { Trace, TraceParent, CallingAgent, SpineFmt } from './context';
import { Agent, type FormatConfig } from './Agent';
import type { AgentPolicy, ToolRetryAction } from './AgentPolicy';
import { Tool, ToolRetryError, takeToolMedia, TOOL_CONTEXT_KEY, TOOL_IMAGE_ERROR_KEY } from './Tool';
import type { Emitter } from './emit';
import { ContextPressure } from './pressure';
import { prepareBatch } from './prepare-content';
import { replayAgentTurns } from './replay';
import { failSettled, discardSpawn } from './apply';
import type { EntailmentScorer } from './source';
import type { TraceWriter } from './trace-writer';
import type { TraceEvent } from './trace-types';
import {
  type Schedule, type Outputs, type Pending, type PrefillItem, type ToolCompletion,
  type DispatchRequest, type Ladder, classifyRc, prunable,
} from './state';
import type { AgentTaskSpec, AgentEvent, ToolContext, PressureThresholds } from './types';

/**
 * The one module that issues decodes.
 *
 * `prefill`, `prefillMultimodal` and `commit` are the three ways cells enter
 * the cache; every caller in the package — the pool's executor, the spine's
 * header, replay, the single-agent root — goes through them, so the
 * settle-before-exit discipline (`waitUntilSettled`) is kept in one place and
 * the single-fiber invariant is a property of the module, not of vigilance.
 *
 * {@link Executor.run} runs a {@link Schedule} in one fixed order:
 * halts → admitted prefills → tool dispatch → spawns/extends/heals → sampling
 * → the batched commit. Prefills complete before any agent samples.
 */

// ── The decode primitives ──────────────────────────────────────

export function* prefill(store: BranchStore, pairs: [Branch, number[]][]): Operation<void> {
  yield* waitUntilSettled(store.prefill(pairs));
}

export function* prefillMultimodal(store: BranchStore, pairs: [Branch, MultimodalDelta][]) {
  return yield* waitUntilSettled(store.prefillMultimodal(pairs));
}

export function* commit(store: BranchStore, entries: [Branch, number][]): Operation<void> {
  yield* waitUntilSettled(store.commit(entries));
}

/** A branch's own prefill (the spine header, a single-branch replay). */
export function* prefillBranch(branch: Branch, tokens: number[]): Operation<void> {
  yield* waitUntilSettled(branch.prefill(tokens));
}

export function* prefillBranchMultimodal(branch: Branch, prompt: string, bitmaps: Uint8Array[], sep?: number[]) {
  return yield* waitUntilSettled(branch.prefillMultimodal(prompt, bitmaps, sep));
}

/** The cells a multimodal delta will cost — measured, never estimated. */
export function* measureCells(ctx: SessionContext, delta: MultimodalDelta): Operation<number> {
  return yield* waitUntilSettled(deltaCells(ctx, delta));
}

// ── Concurrency gate for fan-out tools ─────────────────────────

/** Default cap on concurrent fan-out tool children. */
export const DEFAULT_MAX_CONCURRENT_TOOLS = 8;

/** FIFO counting gate: acquire before a fan-out child's `execute`, release in
 *  an `ensure`. A halt while queued runs the action cleanup (drops the waiter). */
export interface Permits { acquire(): Operation<void>; release(): void }
export function makePermits(n: number): Permits {
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

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// ── Forking an agent ───────────────────────────────────────────

/**
 * Fork an agent from a parent branch with its own system prompt and task.
 * Metadata only — no decode. The suffix prefill is the executor's.
 */
export function* setupAgent(
  parent: Branch, task: AgentTaskSpec, ctx: SessionContext, enableThinking: boolean, clock?: () => number,
): Operation<{ agent: Agent; suffixTokens: number[]; formattedPrompt: string }> {
  // Shared mode: the spine already carries the [system + tools] header; the
  // agent inherits parser/grammar/format/triggers and contributes a user turn.
  let sharedFmt: FormatConfig | null = null;
  try { sharedFmt = (yield* SpineFmt.get()) ?? null; } catch { /* not in shared mode */ }

  const messages = sharedFmt && task.systemPrompt === ''
    ? [{ role: 'user', content: task.content }]
    : [
        { role: 'system', content: task.systemPrompt },
        { role: 'user', content: task.content },
      ];
  const fmtOpts: Record<string, unknown> = { enableThinking };
  if (task.tools && !sharedFmt) fmtOpts.tools = task.tools;
  const fmt = ctx.formatChatSync(JSON.stringify(messages), fmtOpts);
  if (task.tools && !sharedFmt
      && (fmt.format === CHAT_FORMAT_CONTENT_ONLY || fmt.format === CHAT_FORMAT_GENERIC)) {
    throw new Error('Model does not support tool calling. Please use a model with native tool support (e.g. Qwen3, Llama 3.x, Mistral).');
  }
  const branch = parent.forkSync();
  const suffixTokens = [...ctx.getTurnSeparator(), ...ctx.tokenizeSync(fmt.prompt, false)];
  if (task.seed != null) branch.reseedSampler(task.seed);

  let callingAgent: Agent | null = null;
  try { const a = yield* CallingAgent.get(); if (a) callingAgent = a; } catch { /* top-level — no caller */ }

  const src = sharedFmt ?? fmt;
  const fmtConfig: FormatConfig = {
    format: src.format, reasoningFormat: src.reasoningFormat, generationPrompt: src.generationPrompt,
    parser: src.parser, grammar: src.grammar, grammarLazy: src.grammarLazy, grammarTriggers: src.grammarTriggers,
    enableThinking,
  };
  const agent = new Agent({
    id: branch.handle, parentId: parent.handle, branch, parent: callingAgent,
    task: task.content, fmt: fmtConfig, assignedAbility: task.assignedAbility ?? null, clock,
  });
  return { agent, suffixTokens, formattedPrompt: fmt.prompt };
}

// ── The executor ───────────────────────────────────────────────

export interface ExecDeps {
  ctx: SessionContext;
  store: BranchStore;
  tools: Map<string, Tool>;
  emit: Emitter;
  tw: TraceWriter;
  pending: Pending;
  agents: Agent[];
  inflight: Map<number, Task<void>>;
  permits: Permits;
  completed: ToolCompletion[];
  wake: Signal<void, void>;
  progress: Signal<AgentEvent, void>;
  scorer?: EntailmentScorer;
  toolIndexMap: Map<string, number>;
  toolkitSize: number;
  terminalGrammar: string | null;
  eagerGrammar?: string;
  enableThinking: boolean;
  spine: Branch;
  runNow: () => number;
  counters: { warmPrefillCalls: number; warmPrefillBranches: number };
  totals: { toolCalls: number; steps: number };
  policy: AgentPolicy;
  pressureOpts: PressureThresholds;
  ingress: ContentIngress;
  attachments: AttachmentStore;
  ladder: Ladder;
  trace: boolean;
}

export class Executor {
  constructor(private readonly d: ExecDeps) {}

  *run(S: Schedule): Operation<Outputs> {
    const out: Outputs = { tokenRail: null, mediaRail: [], produced: [], committed: false, commitPressure: null, fatal: null };
    const d = this.d;

    // 0. Halts — a cancelled agent's in-flight tool is aborted.
    for (const a of S.halts) {
      const t = d.inflight.get(a.id);
      if (t) yield* t.halt();
    }
    if (S.hold) return out;

    // 1. Admitted prefills: the token rail, the media rail, probes, re-activation.
    const landed = yield* this.settle(S.prefills, out);
    if (out.fatal) return out;

    // 2. Tool dispatch — inline on this fiber, fan-out on a child.
    for (const req of S.dispatch) yield* this.dispatch(req);

    // 3. Spawns, extends and heals: one batched prefill onto forks and the spine.
    const born = yield* this.spawn(S, out);
    if (out.fatal) return out;

    // 4. Sampling — the scheduled decode set, in roster order. Agents that
    //    became active in THIS step (admitted items, spawns, heals) sample next
    //    tick, after the scheduler has had its say on them.
    void landed; void born;
    const set = new Set<Agent>(S.decode);
    const entries: [Branch, number][] = [];
    for (const a of d.agents) {
      if (!set.has(a) || a.status !== 'active') continue;
      const { token, text, isStop } = a.branch.produceSync();
      if (isStop) {
        // The strict parse belongs to the sample: it reads the parser state the
        // sample left behind, before any sibling samples.
        const parsed = a.extracting ? null : a.finalize(d.ctx);
        out.produced.push({ agent: a, token, text, isStop, parsed });
        continue;
      }
      entries.push([a.branch, token]);
      if (d.trace) {
        const entropy = a.branch.modelEntropy();
        const surprisal = a.branch.modelSurprisal(token);
        a.accumulateTokenWithTrace(text, entropy, surprisal);
        a.observe(d.ctx);
        yield* d.emit.emit({ kind: 'produced', agent: a, text, entropy, surprisal });
      } else {
        a.accumulateToken(text);
        a.observe(d.ctx);
        yield* d.emit.emit({ kind: 'produced', agent: a, text });
      }
    }

    // 5. One batched decode for every produced token.
    if (entries.length > 0) {
      try {
        yield* commit(d.store, entries);
        out.committed = true;
        out.commitPressure = new ContextPressure(d.ctx, d.pressureOpts);
      } catch (err) {
        out.fatal = { phase: 'commit', err };
      }
    }
    return out;
  }

  /** Prefill the admitted items; book and re-activate what landed. */
  private *settle(items: PrefillItem[], out: Outputs): Operation<Agent[]> {
    const d = this.d;
    const landed: Agent[] = [];
    const order: { agentId: number; callId: string; cells: number }[] = [];
    const probes = new Map<number, string>();
    const tokenItems = items.filter((it): it is PrefillItem & { rail: 'token' } => it.rail === 'token');
    const mediaItems = items.filter((it): it is PrefillItem & { rail: 'media' } => it.rail === 'media');

    /** Success-only bookkeeping: the record, the tool history, the trace. */
    const book = (it: PrefillItem, cells: number, refs?: readonly Attachment[]): void => {
      const a = it.agent;
      if (it.resultStr) {
        a.records.push({ kind: 'toolResult', resultStr: it.resultStr, callId: it.callId,
          ...(refs && refs.length > 0 ? { attachments: refs } : {}) });
      }
      landed.push(a);
      order.push({ agentId: a.id, callId: it.callId, cells });
      if (it.probe) probes.set(a.id, it.probe);
      a.deferAttempts = 0;
      const after = new ContextPressure(d.ctx, d.pressureOpts);
      a.recordToolResult({ name: it.toolName, args: it.args, resultCells: cells,
        contextAfterPercent: after.percentAvailable, timestamp: performance.now() });
      d.emit.trace({ kind: 'prefilled', agent: a, cells,
        role: it.kind === 'recovery' ? 'recovery' : 'toolResult', attachments: refs });
    };

    if (tokenItems.length > 0) {
      try {
        yield* prefill(d.store, tokenItems.map(t => [t.agent.branch, t.tokens] as [Branch, number[]]));
        d.counters.warmPrefillCalls++;
        d.counters.warmPrefillBranches += tokenItems.length;
        d.ladder.consecutiveFatalRc = 0;
        for (const t of tokenItems) book(t, t.tokens.length);
        out.tokenRail = { items: tokenItems, outcome: { ok: true } };
      } catch (err) {
        const de = decodeErrorOf(err);
        out.tokenRail = { items: tokenItems, outcome: { ok: false, rc: de?.rc, partial: de?.partial, message: toError(err).message } };
        // A fatal rc ends the tick here, as it always did; the interpreter
        // records it and the pool closes partial.
        if (classifyRc(de?.rc, de?.partial, d.ladder.backendSuspect) === 'fatal') {
          out.fatal = { phase: 'prefill', err };
          return landed;
        }
      }
    }
    if (mediaItems.length > 0) {
      const results = yield* prefillMultimodal(d.store, mediaItems.map(m => [m.agent.branch, m.media.delta] as [Branch, MultimodalDelta]));
      d.counters.warmPrefillCalls++;
      d.counters.warmPrefillBranches += mediaItems.length;
      for (let i = 0; i < mediaItems.length; i++) {
        const m = mediaItems[i];
        const r = results[i];
        if (!r?.error) {
          d.ladder.consecutiveFatalRc = 0;
          book(m, m.media.cells, m.media.attachments);
          out.mediaRail.push({ item: m, outcome: { ok: true } });
        } else {
          out.mediaRail.push({ item: m, outcome: { ok: false, rc: r.rc, partial: r.partial, message: r.error } });
        }
      }
    }

    if (landed.length > 0) {
      d.emit.trace({ kind: 'settleOrder', batch: order });
      const probePairs: [Branch, number[]][] = [];
      const probeMeta: { agent: Agent; cells: number; text: string }[] = [];
      for (const a of landed) {
        const text = probes.get(a.id);
        if (!text) continue;
        const tokens = d.ctx.tokenizeSync(text, false);
        probePairs.push([a.branch, tokens]);
        probeMeta.push({ agent: a, cells: tokens.length, text });
      }
      if (probePairs.length > 0) {
        yield* prefill(d.store, probePairs);
        for (const m of probeMeta) {
          d.emit.trace({ kind: 'prefilled', agent: m.agent, cells: m.cells, role: 'probe', probeText: m.text });
          m.agent.records.push({ kind: 'probe', text: m.text });
        }
      }
      // Re-activate. An extracting agent gets the eager terminal-tool grammar
      // (the grammar-swap); everyone else the lazy tool-call grammar.
      for (const a of landed) {
        a.transition('active');
        a.resetTurn();
        if (a.extracting && d.terminalGrammar) a.branch.setGrammar(d.terminalGrammar);
        else this.applyLazyGrammar(a);
      }
    }
    return landed;
  }

  /** Spawns, extends and heals land as one prefill; the new agents activate. */
  private *spawn(S: Schedule, out: Outputs): Operation<Agent[]> {
    const d = this.d;
    const born: Agent[] = [];
    if (S.spawns.length === 0 && S.extends.length === 0 && S.heals.length === 0) return born;

    const heals: { h: Schedule['heals'][number]; agent: Agent; suffixTokens: number[]; formattedPrompt: string }[] = [];
    for (const h of S.heals) {
      const setup = yield* setupAgent(d.spine, h.spec, d.ctx, d.enableThinking, d.runNow);
      heals.push({ h, ...setup });
    }
    // One batch never carries a handle twice (`require_distinct_handles`), so
    // every admitted extend rides as ONE pair on the spine, in request order.
    const extendTokens = S.extends.flatMap(e => e.tokens);
    const pairs: [Branch, number[]][] = [
      ...S.spawns.map(s => [s.agent.branch, s.suffixTokens] as [Branch, number[]]),
      ...heals.map(x => [x.agent.branch, x.suffixTokens] as [Branch, number[]]),
      ...(extendTokens.length > 0 ? [[d.spine, extendTokens] as [Branch, number[]]] : []),
    ];
    try {
      if (pairs.length > 0) yield* prefill(d.store, pairs);
    } catch (err) {
      // Nothing in this batch entered the pool, so nothing may outlive it: the
      // forks go back (their KV leases with them) and every waiter hears why.
      const e = toError(err);
      for (const x of S.extends) x.reject(e);
      for (const s of S.spawns) discardSpawn(s, e);
      for (const { agent } of heals) { agent.branch.pruneSync(); agent.dispose(); }
      out.fatal = { phase: 'prefill', err };
      return born;
    }

    // Each request is answered with its own delta; its record carries the
    // spine position as of ITS landing, the pair having advanced in order.
    let positionAfter = d.spine.position - extendTokens.length;
    for (const e of S.extends) {
      positionAfter += e.tokens.length;
      d.emit.trace({ kind: 'extended', userContent: e.userContent, assistantContent: e.assistantContent,
        deltaTokens: e.tokens.length, positionAfter });
      e.resolve(e.tokens.length);
    }
    for (const s of S.spawns) {
      const a = s.agent;
      a.spec = s.task;
      d.agents.push(a);
      yield* this.activate(a, s.formattedPrompt, s.task, s.suffixTokens.length);
      s.resolve(a);
      born.push(a);
    }
    for (const { h, agent, suffixTokens, formattedPrompt } of heals) {
      agent.spec = h.spec;
      agent.healAttempt = h.attempt;
      d.agents.push(agent);
      d.emit.trace({ kind: 'created', agent });
      d.emit.trace({ kind: 'formatted', agent, promptText: formattedPrompt, taskContent: h.spec.content,
        tokenCount: suffixTokens.length, systemPrompt: h.spec.systemPrompt, tools: h.spec.tools });
      try {
        yield* replayAgentTurns(agent.branch, h.records, { enableThinking: agent.fmt.enableThinking });
      } catch {
        // The replay could not land. The original already failed honestly;
        // the half-built replacement is discarded.
        d.emit.trace({ kind: 'drop', agent, reason: 'pressure_init', done: false });
        agent.failed = 'pressure_init';
        agent.pruneRequested = true;
        continue;
      }
      d.emit.trace({ kind: 'healed', of: h.of, agent, rc: h.rc, attempt: h.attempt, pressure: new ContextPressure(d.ctx, d.pressureOpts) });
      this.applyLazyGrammar(agent);
      agent.transition('active');
      yield* d.emit.emit({ kind: 'spawned', agent, after: h.spec.after });
      born.push(agent);
    }
    return born;
  }

  private *activate(a: Agent, formattedPrompt: string, task: AgentTaskSpec, tokenCount: number): Operation<void> {
    const d = this.d;
    d.emit.trace({ kind: 'created', agent: a });
    d.emit.trace({ kind: 'formatted', agent: a, promptText: formattedPrompt, taskContent: task.content,
      tokenCount, systemPrompt: task.systemPrompt, tools: task.tools });
    this.applyLazyGrammar(a);
    // The transition fires the agent's statusSignal — a waiting orchestrator resumes here.
    a.transition('active');
    yield* d.emit.emit({ kind: 'spawned', agent: a, after: task.after });
  }

  /** Eager grammar (schema agents) beats the lazy tool-call grammar; with no
   *  tools the template's tool grammar is deliberately NOT installed, so a
   *  no-tool agent is free to wander back to prose. */
  applyLazyGrammar(a: Agent): void {
    const d = this.d;
    if (d.eagerGrammar) {
      a.branch.setGrammar(d.eagerGrammar);
    } else if (d.tools.size > 0 && a.fmt.grammar && a.fmt.grammarLazy && a.fmt.grammarTriggers.length > 0) {
      const triggers = a.fmt.grammarTriggers.map(t => {
        if (t.type === GrammarTriggerType.WORD) {
          const nlIdx = t.value.indexOf('\n');
          if (nlIdx >= 0 && nlIdx < t.value.length - 1) return { ...t, value: t.value.slice(0, nlIdx + 1) };
        }
        return t;
      });
      a.branch.setGrammarLazy(a.fmt.grammar, triggers);
    }
  }

  // ── Tools ────────────────────────────────────────────────────

  /** Attribution tee: stamps the dispatching agent + call INTO the event data,
   *  only if absent, so a nested pool's inner stamp wins. */
  private tee(agentId: number, callId: string, dispatchTraceId: number): TraceWriter {
    const tw = this.d.tw;
    return {
      nextId: () => tw.nextId(),
      flush: () => tw.flush(),
      write: (event: TraceEvent) => tw.write({
        ...event,
        agentId: event.agentId ?? agentId,
        callId: event.callId ?? callId,
        parentTraceId: event.parentTraceId ?? dispatchTraceId,
      }),
    };
  }

  private *dispatch(req: DispatchRequest): Operation<void> {
    const d = this.d;
    const { agent, tc, retryAttempt, retryCallId } = req;
    let toolArgs: Record<string, unknown>;
    try { toolArgs = JSON.parse(tc.arguments); } catch { toolArgs = {}; }
    const callId = retryCallId ?? (tc.id || `call_${agent.toolCallCount}`);

    // Retries re-execute the SAME call — counters and the bus event belong to the first attempt.
    if (retryAttempt === undefined) {
      agent.incrementToolCalls();
      d.totals.toolCalls++;
      agent.incrementTurns();
      yield* d.emit.emit({ kind: 'toolCalled', agent, tool: tc.name, args: tc.arguments });
    }

    const tool = d.tools.get(tc.name);
    const tee = this.tee.bind(this);
    const reading = new ContextPressure(d.ctx, d.pressureOpts);
    const explore = d.policy.shouldExplore?.(agent, reading) ?? true;
    const dispatchTraceId = d.emit.nextId();
    const toolT0 = performance.now();
    d.emit.trace({ kind: 'dispatched', traceId: dispatchTraceId, ts: toolT0, agent, tool: tc.name,
      toolIndex: d.toolIndexMap.get(tc.name) ?? -1, toolkitSize: d.toolkitSize, args: toolArgs, callId,
      explore, percentAvailable: reading.percentAvailable });
    const peerHistory = d.agents.filter(a => a.id !== agent.id).flatMap(a => a.toolHistory);
    const toolContext: ToolContext = {
      agentId: agent.id, branch: agent.branch,
      onProgress: (p: { filled: number; total: number }) => {
        d.progress.send({ type: 'agent:tool_progress', agentId: agent.id, tool: tc.name, filled: p.filled, total: p.total });
      },
      scorer: d.scorer, explore,
      pressurePercentAvailable: reading.percentAvailable,
      peerHistory,
    };

    if (tool?.fanout) {
      // Off the loop fiber. The child runs ONLY execute(); its completion is
      // interpreted on this fiber when the loop next observes.
      const fanoutTool = tool;
      d.inflight.set(agent.id, yield* spawn(function*() {
        let took = false;
        try {
          yield* ensure(() => { d.inflight.delete(agent.id); });
          yield* ensure(() => { if (took) d.permits.release(); });
          yield* d.permits.acquire(); took = true;
          yield* TraceParent.set(dispatchTraceId);
          yield* CallingAgent.set(agent);
          yield* Trace.set(tee(agent.id, callId, dispatchTraceId));
          const result: unknown = yield* scoped(function*() {
            return yield* call(() => fanoutTool.execute(toolArgs, toolContext));
          });
          d.completed.push({ kind: 'result', agent, tc, callId, dispatchTraceId, toolT0, result });
        } catch (err) {
          // A halt unwinds via ensure, not catch: a halted child pushes nothing.
          if (err instanceof ToolRetryError) {
            d.completed.push({ kind: 'retry', agent, tc, callId, dispatchTraceId, toolT0, retryAttempt: (retryAttempt ?? 0) + 1, err });
          } else {
            d.completed.push({ kind: 'error', agent, tc, callId, dispatchTraceId, err: toError(err) });
          }
        } finally {
          d.wake.send();
        }
      }));
      return;
    }

    // Inline: run and interpret now, on this fiber. Required for any tool
    // that decodes on the main context (delegate, plan).
    let completion: ToolCompletion;
    try {
      yield* TraceParent.set(dispatchTraceId);
      yield* CallingAgent.set(agent);
      yield* Trace.set(tee(agent.id, callId, dispatchTraceId));
      const result: unknown = yield* scoped(function*() {
        return yield* call(() =>
          tool ? tool.execute(toolArgs, toolContext) : Promise.resolve({
            error: d.tools.size === 0
              ? 'No tools are available to this agent. Do not emit tool calls — write your answer directly as plain text.'
              : `Unknown tool: ${tc.name}`,
          }),
        );
      });
      completion = { kind: 'result', agent, tc, callId, dispatchTraceId, toolT0, result };
    } catch (err) {
      completion = err instanceof ToolRetryError
        ? { kind: 'retry', agent, tc, callId, dispatchTraceId, toolT0, retryAttempt: (retryAttempt ?? 0) + 1, err }
        : { kind: 'error', agent, tc, callId, dispatchTraceId, err: toError(err) };
    }
    yield* this.intake(completion);
  }

  /**
   * Interpret one tool completion ON THE LOOP FIBER: the result becomes a
   * pending item (tokenized here, or measured on the embedding rail), a
   * transient failure parks a retry, a hard error ends the agent. Shared by
   * the inline path and the fan-out drain.
   */
  *intake(c: ToolCompletion): Operation<void> {
    try {
      yield* this.intakeInner(c);
    } catch (err) {
      // The media barrier is the live case. One agent's failure must not take
      // the tick — or its siblings — with it.
      yield* failSettled(this.d.emit, c.agent, 'tool_result_failed', toError(err).message, undefined, c.dispatchTraceId);
    }
  }

  private *intakeInner(c: ToolCompletion): Operation<void> {
    const d = this.d;
    const { agent, tc, callId, dispatchTraceId } = c;
    // Discarded while the tool ran: a late event would contradict its terminal one.
    if (agent.failed !== null) return;

    if (c.kind === 'error') {
      agent.transition('idle');
      agent.setResult(`Tool error: ${c.err.message}`, 'tool_error');
      d.emit.trace({ kind: 'toolError', agent, tool: tc.name, error: c.err.message, parentTraceId: dispatchTraceId });
      return;
    }
    if (c.kind === 'retry') {
      const attempt = c.retryAttempt;
      const retryAction: ToolRetryAction =
        d.policy.onToolRetry?.(agent, tc.name, c.err, attempt)
          ?? (attempt <= 1 ? { type: 'retry' } : { type: 'fail' });
      if (retryAction.type === 'retry') {
        const afterMs = retryAction.afterMs ?? c.err.retryAfterMs;
        d.pending.retries.push({ agent, tc, callId, notBefore: performance.now() + afterMs, attempt });
        yield* d.emit.emit({ kind: 'toolRetry', agent, tool: tc.name, callId, retryAfterMs: afterMs, attempt, parentTraceId: dispatchTraceId });
        return;
      }
      const exhausted = {
        error: retryAction.message
          ?? `${tc.name} is currently unavailable (rate-limited; retry failed). ` +
            `Do not call ${tc.name} again — use other sources or proceed with your current findings.`,
      };
      const resultStr = JSON.stringify(exhausted);
      yield* d.emit.emit({ kind: 'toolTold', agent, tool: tc.name, resultStr });
      const tokens = buildToolResultDelta(d.ctx, resultStr, callId, { enableThinking: agent.fmt.enableThinking });
      d.emit.trace({ kind: 'toolResult', agent, tool: tc.name, result: exhausted, cells: tokens.length,
        durationMs: performance.now() - c.toolT0, parentTraceId: dispatchTraceId });
      d.pending.items.push({ kind: 'toolResult', rail: 'token', agent, tokens, toolName: tc.name, callId, args: tc.arguments, resultStr });
      return;
    }

    const result = c.result;
    const tool = d.tools.get(tc.name);
    const contextAvailablePercent = new ContextPressure(d.ctx, d.pressureOpts).percentAvailable;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const obj = result as Record<string, unknown>;
      obj[TOOL_CONTEXT_KEY] = contextAvailablePercent;
      if (Array.isArray(obj.results)) agent.addNestedResults((obj.results as unknown[]).filter((f): f is string => typeof f === 'string'));
      if (Array.isArray(obj.nestedResults)) agent.addNestedResults((obj.nestedResults as unknown[]).filter((f): f is string => typeof f === 'string'));
    }
    // Images come OUT before serializing; a model with no projector is TOLD.
    const { media, result: told } = takeToolMedia(result);
    if (media.length > 0 && !d.ctx.supportsVision()) {
      (told as Record<string, unknown>)[TOOL_IMAGE_ERROR_KEY] =
        `${tc.name} returned ${media.length} image(s), but this model cannot see images. ` +
        `Work from the text, or use a different source.`;
    }
    const resultStr = JSON.stringify(told);
    yield* d.emit.emit({ kind: 'toolTold', agent, tool: tc.name, resultStr, contextAvailablePercent });
    const common = { agent, toolName: tc.name, callId, args: tc.arguments, resultStr, probe: tool?.probe(told) ?? undefined };
    let item: PrefillItem;
    if (media.length > 0 && d.ctx.supportsVision()) {
      // THE BARRIER: normalized and committed before a marker exists, before
      // admission, before any KV moves. A failure here is not a tool retry.
      const prepared = yield* prepareBatch(d.ingress, d.attachments, media);
      const delta = buildToolResultDeltaMultimodal(d.ctx, resultStr, callId, prepared.bitmaps as Uint8Array[], { enableThinking: agent.fmt.enableThinking });
      const cells = yield* measureCells(d.ctx, delta);
      item = { kind: 'toolResult', rail: 'media', ...common, media: { delta, cells, attachments: prepared.attachments } };
    } else {
      const tokens = buildToolResultDelta(d.ctx, resultStr, callId, { enableThinking: agent.fmt.enableThinking });
      item = { kind: 'toolResult', rail: 'token', ...common, tokens };
    }
    d.emit.trace({ kind: 'toolResult', agent, tool: tc.name, result: told,
      cells: item.rail === 'media' ? item.media.cells : item.tokens.length,
      durationMs: performance.now() - c.toolT0, parentTraceId: dispatchTraceId });
    d.pending.items.push(item);
  }

  // ── Reclamation ──────────────────────────────────────────────

  /** Prune every branch that is owed a prune and is a childless leaf. Returns
   *  how many were freed. A branch with live children keeps its prefix; the
   *  request stands until the children go. */
  prunePass(): number {
    let n = 0;
    for (const a of this.d.agents) {
      if (!prunable(a)) { if (a.pruneRequested && a.branch.disposed) a.pruneRequested = false; continue; }
      a.harvestMetrics();
      if (a.branch.children.length > 0) continue;
      this.d.emit.trace({ kind: 'pruned', agent: a, position: a.branch.position });
      a.branch.pruneSync();
      a.pruneRequested = false;
      n++;
    }
    return n;
  }
}

/** Teardown: free every agent branch that is still a leaf, children first. */
export function pruneAll(agents: readonly Agent[], emit: Emitter): void {
  for (let i = agents.length - 1; i >= 0; i--) {
    const a = agents[i];
    a.harvestMetrics();
    if (!a.branch.disposed && a.branch.children.length === 0) {
      emit.trace({ kind: 'pruned', agent: a, position: a.branch.position });
      a.branch.pruneSync();
    }
  }
}
