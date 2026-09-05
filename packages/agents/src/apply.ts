import type { Operation } from 'effection';
import type { SessionContext, ParsedToolCall, ParseChatOutputResult } from '@lloyal-labs/sdk';
import { buildToolResultDelta, buildUserDelta, decodeErrorOf } from '@lloyal-labs/sdk';
import type { Agent } from './Agent';
import type { AgentPolicy, PolicyConfig } from './AgentPolicy';
import type { Tool } from './Tool';
import { TOOL_IMAGE_ERROR_KEY } from './Tool';
import type { Emitter } from './emit';
import { ContextPressure } from './pressure';
import { recoveryFor } from './scheduler';
import {
  type Schedule, type Outputs, type Pending, type Drop, type Recovery, type PrefillItem,
  type PrefillOutcome, type Ladder, type DropReason,
  alive, classifyRc, isFatalRc, MAX_DEFER_ATTEMPTS, BACKEND_TRIPWIRE_N, MAX_HEAL_ATTEMPTS,
} from './state';
import type { PressureThresholds } from './types';

/**
 * The interpreter: turns decisions and outcomes into agent transitions.
 *
 * Two entry points, one per half of the tick. {@link Applier.applySchedule}
 * enacts what the scheduler decided BEFORE the store runs (drops, the
 * stall-break, the sweep); {@link Applier.applyOutputs} interprets what the
 * store gave back (the ladder on failed prefills, stopped agents through
 * `policy.onProduced`, the commit). Both write agents only through their
 * methods and announce every change through the one {@link Emitter}.
 */

export interface ApplyDeps {
  ctx: SessionContext;
  policy: AgentPolicy;
  config: PolicyConfig;
  tools: Map<string, Tool>;
  emit: Emitter;
  pending: Pending;
  ladder: Ladder;
  recovery: 'serial' | 'cohort';
  recoveryBudget?: number;
  terminalToolName?: string;
  pruneOnReturn: boolean;
  pressureOpts: PressureThresholds;
  totals: { toolCalls: number; steps: number };
}

/** Strip a trailing UNCLOSED `<tool_call>` fragment from text captured as an
 *  agent result — a truncated call must not ride into another agent's prompt
 *  as an in-context demonstration of emitting tool calls. Complete blocks
 *  are left alone. */
export function stripDanglingToolCall(text: string): string {
  return text.replace(/<tool_call>(?:(?!<\/tool_call>)[\s\S])*$/, '').trimEnd();
}

/** Extract the terminal-tool result string from a parsed (possibly TRUNCATED)
 *  tool call: valid JSON → `.result`; a token-stop cuts mid-call, so salvage
 *  the `result` body from the partial and unescape it; else the raw arguments
 *  (a non-`{result}` terminal tool). */
export function extractTerminalResult(args: string): string {
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

export class Applier {
  constructor(private readonly d: ApplyDeps) {}

  // ── Before the store runs ──────────────────────────────────────

  *applySchedule(S: Schedule): Operation<void> {
    for (const drop of S.drops) yield* this.enactDrop(drop, S);
    for (const a of S.finishes) yield* this.finishExtraction(a);
    for (const o of S.stall) {
      // The nudge record captures "policy consulted, returned nudge" whether
      // or not the nudge was actionable; the drop it fell into follows.
      if (o.nudge) {
        yield* this.d.emit.emit({ kind: 'nudged', agent: o.agent, reason: 'settle_reject', message: o.nudge.message, tool: o.nudge.tool, args: o.nudge.args });
        if (o.nudge.replacement) o.agent.incrementTurns();
      }
      if (o.drop) yield* this.enactDrop(o.drop, S);
    }
    for (const r of S.abandoned) {
      // The drain reports with what agents HAVE: an honest failure settles
      // through the normal path and the next reap recovers the report.
      const result = { error:
        `${r.tc.name} is unavailable (rate-limited) and the run is winding down — ` +
        `report your findings with what you have.` };
      const resultStr = JSON.stringify(result);
      yield* this.d.emit.emit({ kind: 'toolTold', agent: r.agent, tool: r.tc.name, resultStr });
      const tokens = buildToolResultDelta(this.d.ctx, resultStr, r.callId, { enableThinking: r.agent.fmt.enableThinking });
      this.d.emit.trace({ kind: 'toolResult', agent: r.agent, tool: r.tc.name, result, cells: tokens.length, durationMs: 0 });
      this.d.pending.items.push({ kind: 'toolResult', rail: 'token', agent: r.agent, tokens, toolName: r.tc.name, callId: r.callId, args: r.tc.arguments });
    }
    for (const req of S.rejectedSpawns) {
      // A fork that never entered the pool: free it and tell the orchestrator.
      req.agent.branch.pruneSync();
      req.agent.dispose();
      if (req.discarded) continue;
      this.d.emit.trace({ kind: 'drop', agent: req.agent, reason: 'pressure_init', done: false });
      req.reject(new Error(`useAgentPool: cannot fit agent suffix (${req.suffixTokens.length} tokens) under current pressure`));
    }
    if (S.sweep) yield* this.recover(S.sweep.agent, S.sweep.recovery, null);
  }

  /** One drop, whatever decided it: the record, then the recovery it carries. */
  *enactDrop(d: Drop, S: Schedule): Operation<void> {
    const a = d.agent;
    if (d.reason === 'user_cancel') {
      yield* this.d.emit.emit({ kind: 'cancelled', agent: a });
      a.failed = 'user_cancel';
      a.transition('idle');
      a.pruneRequested = true;
      return;
    }
    if (d.exitReason) a.exitReason = d.exitReason;
    // An agent that simply idles (no recovery) transitions first, so a
    // waiting orchestrator resumes on the same edge it always has.
    if (d.recovery.type === 'none' && a.status !== 'idle') a.transition('idle');
    yield* this.d.emit.emit({ kind: 'drop', agent: a, reason: d.reason, done: d.done });
    yield* this.recover(a, d.recovery, d.reason);
    void S;
  }

  /** Enact the recovery decided for an agent whose span has ended. */
  *recover(a: Agent, recovery: Recovery, reason: DropReason | null): Operation<void> {
    switch (recovery.type) {
      case 'none':
        return;
      case 'salvage': {
        // Mid-terminal-call: parse what it already emitted; no further decode.
        // `rawOutput` is the report turn alone (resetTurn cleared the rest).
        const produced = reason === 'terminal_cap' ? a.turnTokens : this.d.ctx.tokenizeSync(a.rawOutput, false).length;
        yield* this.finishRecovery(a, a.rawOutput, produced);
        a.transition('idle');
        a.pruneRequested = true;
        return;
      }
      case 'skip': {
        // `agent:done` already fired; without a terminal event the consumer
        // would orphan the agent in an eternal "recovering" state.
        yield* this.d.emit.emit({ kind: 'recoveryFailed', agent: a, reason: 'recovery_skipped', outputExcerpt: a.rawOutput.slice(0, 200) });
        a.failed = 'recovery_skipped';
        a.pruneRequested = true;
        if (a.status !== 'idle') a.transition('idle');
        return;
      }
      case 'extract': {
        // The recovery turn is a pending item. The agent is parked BEFORE
        // anything else happens, so it never passes through `idle` on the way
        // — an orchestrator waiting on it would otherwise resume against a
        // result that does not exist yet.
        const tokens = buildUserDelta(this.d.ctx, recovery.action.prompt.user, { system: recovery.action.prompt.system, enableThinking: false });
        a.incrementTurns();
        if (a.status !== 'awaiting_tool') a.transition('awaiting_tool');
        a.markExtracting(recovery.budget, recovery.serial);
        a.resetTurn();
        this.d.pending.items.push({ kind: 'recovery', rail: 'token', agent: a, tokens, toolName: 'recovery', callId: `recovery:${a.id}`, args: '' });
        return;
      }
    }
  }

  /** A finished (or token-stopped) in-loop report: extract, idle, free the branch. */
  *finishExtraction(a: Agent): Operation<void> {
    yield* this.finishRecovery(a, a.rawOutput, a.recoveryTokens);
    a.transition('idle');
    a.pruneRequested = true;
  }

  /** Parse a recovery output, set the result (source `recovery`), announce. */
  *finishRecovery(a: Agent, output: string, producedTokens: number): Operation<boolean> {
    yield* this.d.emit.emit({ kind: 'recoveryProduce', agent: a, tokenCount: producedTokens, outputLength: output.length });
    const parsed = this.d.ctx.parseChatOutput(output, a.fmt.format, {
      reasoningFormat: a.fmt.reasoningFormat, generationPrompt: a.fmt.generationPrompt, parser: a.fmt.parser,
    });
    // With a terminal tool designated the report MUST be that tool's call;
    // without one, whatever the model produced.
    const terminal = this.d.terminalToolName;
    const call = terminal ? parsed.toolCalls.find(c => c.name === terminal) : parsed.toolCalls[0];
    if (call) {
      const result = extractTerminalResult(call.arguments);
      if (result) {
        a.setResult(stripDanglingToolCall(result), 'recovery');
        yield* this.d.emit.emit({ kind: 'recovered', agent: a, result: a.result! });
        return true;
      }
    }
    const reason = call ? 'empty_terminal_result' : 'no_terminal_call';
    yield* this.d.emit.emit({ kind: 'recoveryFailed', agent: a, reason, outputExcerpt: output.slice(0, 200) });
    a.failed = reason;
    return false;
  }

  // ── After the store ran ────────────────────────────────────────

  *applyOutputs(out: Outputs, S: Schedule): Operation<void> {
    if (out.tokenRail && !out.tokenRail.outcome.ok) yield* this.tokenRailFailed(out.tokenRail.items, out.tokenRail.outcome);
    for (const { item, outcome } of out.mediaRail) if (!outcome.ok) yield* this.mediaEntryFailed(item, outcome);

    for (const p of out.produced) {
      if (!p.isStop) continue;
      yield* this.stopped(p.agent, p.parsed, S);
    }

    if (out.committed) {
      this.d.totals.steps++;
      yield* this.d.emit.emit({ kind: 'tick', activeAgents: this.countAlive(S), pressure: out.commitPressure! });
    }
    if (out.fatal) {
      if (out.fatal.phase === 'commit') {
        // KV exhausted mid-report: announce each in-flight extractor failed
        // BEFORE the pool closes partial, else the UI spins on "writing report".
        const reason = `scope_error: ${(out.fatal.err as Error)?.message ?? 'unknown'}`;
        for (const a of this.agentsOf(S)) {
          if (!a.extracting || a.status !== 'active') continue;
          yield* this.d.emit.emit({ kind: 'recoveryFailed', agent: a, reason, outputExcerpt: a.rawOutput.slice(0, 200) });
          a.failed = reason;
        }
      }
      throw out.fatal.err;
    }
  }

  private countAlive(S: Schedule): number {
    return this.agentsOf(S).filter(alive).length;
  }

  /** Every agent the pool holds — the scheduler's view of the roster. */
  private agentsOf(S: Schedule): readonly Agent[] {
    return S.roster;
  }

  /** The agent hit its stop token: the turn is over; the policy decides. */
  private *stopped(a: Agent, parsed: ParseChatOutputResult | null, S: Schedule): Operation<void> {
    if (a.extracting || !parsed) { yield* this.finishExtraction(a); return; }
    yield* this.d.emit.emit({ kind: 'turn', agent: a, parsed });
    a.records.push({ kind: 'assistant', text: a.rawOutput });
    const action = this.d.policy.onProduced(a, parsed, S.pressure, this.d.config);
    switch (action.type) {
      case 'free_text_return':
        a.setResult(stripDanglingToolCall(action.content), 'free_text');
        a.transition('idle');
        yield* this.d.emit.emit({ kind: 'returned', agent: a, via: 'free_text' });
        return;
      case 'idle': {
        const reason: DropReason | null = action.reason === 'free_text_stop' ? null
          : action.reason === 'max_turns' ? 'maxTurns' : 'pressure_softcut';
        const exitReason = reason === 'maxTurns' || reason === 'pressure_softcut' ? reason : undefined;
        const mode = S.mode;
        yield* this.enactDrop({
          agent: a, reason, done: true, exitReason,
          recovery: mode === 'cohort'
            ? recoveryFor(a, this.d.policy, S.pressure, S.alive, 'cohort', this.d.recoveryBudget)
            : { type: 'none' },
        }, S);
        return;
      }
      case 'nudge': {
        const tc = parsed.toolCalls[0] as ParsedToolCall | undefined;
        if (action.guard === 'auth_reject') yield* this.d.emit.emit({ kind: 'authRejected', agent: a, attemptedTool: parsed.toolCalls[0].name });
        yield* this.nudge(a, action.message, tc);
        yield* this.d.emit.emit({ kind: 'nudged', agent: a, reason: 'nudge', message: action.message, tool: tc?.name, args: tc?.arguments, guard: action.guard });
        return;
      }
      case 'return': {
        const tc = parsed.toolCalls[0];
        a.setResult(stripDanglingToolCall(action.result), 'voluntary_return');
        a.transition('idle');
        a.incrementToolCalls();
        this.d.totals.toolCalls++;
        yield* this.d.emit.emit({ kind: 'returned', agent: a, via: { tool: this.d.terminalToolName!, args: tc.arguments } });
        if (this.d.pruneOnReturn) a.pruneRequested = true;
        return;
      }
      case 'tool_call':
        a.transition('awaiting_tool');
        this.d.pending.dispatches.push({ agent: a, tc: action.tc });
        a.resetTurn();
        return;
    }
  }

  /** Replace a rejected call with a compact error payload the model reads next turn. */
  private *nudge(a: Agent, message: string, tc: ParsedToolCall | undefined): Operation<void> {
    const callId = tc?.id || `call_${a.toolCallCount}`;
    const nudgeResult = { error: message };
    a.incrementTurns();
    a.transition('awaiting_tool');
    const tokens = buildToolResultDelta(this.d.ctx, JSON.stringify(nudgeResult), callId, { enableThinking: a.fmt.enableThinking });
    const probe = this.d.tools.get(tc?.name || '')?.probe(nudgeResult) ?? undefined;
    a.resetTurn();
    this.d.pending.items.push({ kind: 'nudge', rail: 'token', agent: a, tokens, toolName: tc?.name || '', callId, args: tc?.arguments || '', probe });
  }

  // ── The ladder ─────────────────────────────────────────────────

  private *tokenRailFailed(items: PrefillItem[], o: PrefillOutcome & { ok: false }): Operation<void> {
    switch (classifyRc(o.rc, o.partial, this.d.ladder.backendSuspect)) {
      case 'fail':
        // An earlier chunk landed and the error does not say which: the cohort
        // takes the per-agent terminal rather than decode landed cells twice.
        for (const it of items) yield* this.failSettled(it.agent, 'tool_result_failed', `partial prefill: ${o.message}`, o.rc);
        return;
      case 'defer':
        for (const it of items) yield* this.defer(it, o.rc!, `deferral exhausted after ${MAX_DEFER_ATTEMPTS} attempts: ${o.message}`, 'tool_result_failed');
        return;
      case 'fatal':
        if (isFatalRc(o.rc)) this.d.ladder.consecutiveFatalRc++;
        throw Object.assign(new Error(o.message), { rc: o.rc, partial: o.partial });
    }
  }

  private *mediaEntryFailed(it: PrefillItem, o: PrefillOutcome & { ok: false }): Operation<void> {
    const a = it.agent;
    if (o.rc === 1 && !o.partial && !this.d.ladder.backendSuspect) {
      yield* this.defer(it, o.rc, `deferral exhausted after ${MAX_DEFER_ATTEMPTS} attempts: ${o.message}`, 'media_prefill_failed');
      return;
    }
    if (o.rc === -1 && !o.partial && !this.d.ladder.backendSuspect) {
      // Invalid input, state restored: the item is deterministic and retrying
      // loops. Tell the model what it did not see, on the same channel the
      // no-projector path uses; the note lands as the next admission.
      const told = JSON.parse(it.resultStr!) as Record<string, unknown>;
      const note = { ...told, [TOOL_IMAGE_ERROR_KEY]:
        `${it.toolName} returned media the decoder rejected as invalid input. Work from the text, or use a different source.` };
      const noteStr = JSON.stringify(note);
      const tokens = buildToolResultDelta(this.d.ctx, noteStr, it.callId, { enableThinking: a.fmt.enableThinking });
      this.d.pending.items.push({ kind: 'toolResult', rail: 'token', agent: a, tokens, toolName: it.toolName, callId: it.callId, args: it.args, probe: it.probe, resultStr: noteStr });
      return;
    }
    if (isFatalRc(o.rc)) {
      this.d.ladder.consecutiveFatalRc++;
      if (this.d.ladder.consecutiveFatalRc >= BACKEND_TRIPWIRE_N) this.d.ladder.backendSuspect = true;
    }
    const detail = this.d.ladder.backendSuspect
      ? `${o.message} [backend suspect: ${this.d.ladder.consecutiveFatalRc} consecutive fatal decodes — recreate the backend]`
      : o.message;
    yield* this.failSettled(a, 'media_prefill_failed', detail, o.rc);
    // HEAL: the poison cost the agent its branch, not its task. Replay up to
    // the last COMPLETED transaction — the poisoned turn's own assistant text
    // is dropped so the replacement regenerates it and drives the tool itself.
    const attempt = a.healAttempt + 1;
    if (!this.d.ladder.backendSuspect && attempt <= MAX_HEAL_ATTEMPTS && a.spec) {
      const records = a.records.slice();
      while (records.length > 0 && records[records.length - 1].kind === 'assistant') records.pop();
      this.d.pending.heals.push({ spec: a.spec, records, of: a.id, ...(o.rc !== undefined ? { rc: o.rc } : {}), attempt });
    }
  }

  private *defer(it: PrefillItem, rc: number, exhaustedDetail: string, reason: 'media_prefill_failed' | 'tool_result_failed'): Operation<void> {
    const a = it.agent;
    const attempt = ++a.deferAttempts;
    if (attempt > MAX_DEFER_ATTEMPTS) { yield* this.failSettled(a, reason, exhaustedDetail, rc); return; }
    yield* this.d.emit.emit({ kind: 'deferred', agent: a, rc, attempt, pressure: new ContextPressure(this.d.ctx, this.d.pressureOpts) });
    this.d.pending.items.push(it);
  }

  *failSettled(a: Agent, reason: 'media_prefill_failed' | 'tool_result_failed', detail: string, rc?: number): Operation<void> {
    yield* failSettled(this.d.emit, a, reason, detail, rc);
  }
}

/** The ladder's bottom rung: the agent is DISCARDED — announced, pruned, never
 *  resumed. Shared with the executor's intake, whose failures carry the
 *  dispatch as their trace parent. */
export function* failSettled(
  emit: Emitter, a: Agent, reason: 'media_prefill_failed' | 'tool_result_failed',
  detail: string, rc?: number, parentTraceId?: number,
): Operation<void> {
  yield* emit.emit({ kind: 'settleFailed', agent: a, reason, detail, rc, parentTraceId });
  a.failed = reason;
  a.pruneRequested = true;
  if (a.status !== 'idle') a.transition('idle');
}

export { decodeErrorOf };
export type { ParseChatOutputResult };
