import type { Operation } from 'effection';
import type { ParseChatOutputResult } from '@lloyal-labs/sdk';
import type { Attachment } from '@lloyal-labs/media';
import type { Agent } from './Agent';
import type { AgentEvent } from './types';
import type { TraceEvent } from './trace-types';
import type { TraceWriter } from './trace-writer';
import type { DropReason } from './state';
import { type ContextPressure, finiteOrNull, pressureRecord } from './pressure';

/**
 * The projection from what the pool DID to what the wire says.
 *
 * Every trace record and every channel event the pool emits is produced here,
 * from a {@link Transition} value, as an ORDERED list of emissions. Today's
 * contract — the event types, their fields, and the order within a sequence
 * (a return is `agent:done` on the trace, then `agent:return` on the bus,
 * then `agent:done` on the bus) — is this one function. A different wire
 * format is a different projection, never a second emitter in the loop.
 *
 * Attribution lives in the data: agent-owned records carry `agentId` (or
 * `branchHandle`) on the record itself; the writer never re-derives it.
 */

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A trace event minus the writer's envelope. `ts` defaults to now,
 *  `parentTraceId` to the pool scope, `traceId` to the next id. */
export type TraceBody = DistOmit<TraceEvent, 'traceId' | 'ts' | 'parentTraceId'> & {
  traceId?: number; ts?: number; parentTraceId?: number | null;
};

export type Emission = { trace: TraceBody } | { bus: AgentEvent };

/** The unit of change the pool announces. */
export type Transition =
  // ── the agent's span ──
  | { kind: 'drop'; agent: Agent; reason: DropReason | null; done: boolean }
  | { kind: 'returned'; agent: Agent; via: { tool: string; args: string } | 'free_text' }
  | { kind: 'cancelled'; agent: Agent }
  | { kind: 'spawned'; agent: Agent; after?: number[] }
  | { kind: 'created'; agent: Agent }
  | { kind: 'formatted'; agent: Agent; promptText: string; taskContent: string; tokenCount: number; systemPrompt: string; tools?: string }
  | { kind: 'turn'; agent: Agent; parsed: ParseChatOutputResult }
  | { kind: 'produced'; agent: Agent; text: string; entropy?: number; surprisal?: number }
  // ── recovery ──
  | { kind: 'recoveryProduce'; agent: Agent; tokenCount: number; outputLength: number }
  | { kind: 'recovered'; agent: Agent; result: string }
  | { kind: 'recoveryFailed'; agent: Agent; reason: string; outputExcerpt: string }
  // ── admission and the ladder ──
  | { kind: 'settleFailed'; agent: Agent; reason: 'media_prefill_failed' | 'tool_result_failed'; detail: string; rc?: number; parentTraceId?: number }
  | { kind: 'deferred'; agent: Agent; rc: number; attempt: number; pressure: ContextPressure }
  | { kind: 'healed'; of: number; agent: Agent; rc?: number; attempt: number; pressure: ContextPressure }
  | { kind: 'prefilled'; agent: Agent; cells: number; role: 'toolResult' | 'recovery' | 'probe'; attachments?: readonly Attachment[]; probeText?: string }
  | { kind: 'settleOrder'; batch: Array<{ agentId: number; callId: string; cells: number }> }
  | { kind: 'pruned'; agent: Agent; position: number }
  // ── nudges and guards ──
  | { kind: 'nudged'; agent: Agent; reason: 'nudge' | 'settle_reject'; message: string; tool?: string; args?: string; guard?: string }
  | { kind: 'authRejected'; agent: Agent; attemptedTool: string }
  // ── tools ──
  | { kind: 'toolCalled'; agent: Agent; tool: string; args: string }
  | { kind: 'dispatched'; traceId: number; ts: number; agent: Agent; tool: string; toolIndex: number; toolkitSize: number; args: Record<string, unknown>; callId: string; explore: boolean; percentAvailable: number }
  /** The model is TOLD the result — the bus event, sent before the barrier
   *  measures it, so a consumer sees the tool answer even if admission fails. */
  | { kind: 'toolTold'; agent: Agent; tool: string; resultStr: string; contextAvailablePercent?: number }
  /** The result's record on the trace, written once its cost is known. */
  | { kind: 'toolResult'; agent: Agent; tool: string; result: unknown; cells: number; durationMs: number; parentTraceId?: number }
  | { kind: 'toolRetry'; agent: Agent; tool: string; callId: string; retryAfterMs: number; attempt: number; parentTraceId: number }
  | { kind: 'toolError'; agent: Agent; tool: string; error: string; parentTraceId: number }
  // ── the spine and the pool ──
  | { kind: 'extended'; userContent: string; assistantContent: string; deltaTokens: number; positionAfter: number }
  | { kind: 'opened'; pressure: ContextPressure }
  | { kind: 'closed'; agents: readonly Agent[]; steps: number; durationMs: number }
  | { kind: 'tick'; activeAgents: number; pressure: ContextPressure }
  | { kind: 'kvTick'; pressure: ContextPressure }
  | { kind: 'paused'; ts: number }
  | { kind: 'resumed'; pausedMs: number }
  | { kind: 'windingDown' };

const agentDone = (agent: Agent): Emission[] => [
  // Trace before the suspending bus send: the send waits on subscriber
  // backpressure, which must not inflate the span-end ts.
  { trace: { type: 'agent:done', agentId: agent.id } },
  { bus: { type: 'agent:done', agentId: agent.id } },
];

/** Branch metrics for the close record: the pre-prune harvest once the branch is gone. */
const pplOf = (a: Agent): number => a.branch.disposed ? (a.finalPpl ?? 0) : a.branch.perplexity;

export function project(t: Transition): Emission[] {
  switch (t.kind) {
    case 'drop': {
      const out: Emission[] = [];
      if (t.reason) out.push({ trace: { type: 'pool:agentDrop', agentId: t.agent.id, reason: t.reason } });
      if (t.done) out.push(...agentDone(t.agent));
      return out;
    }
    case 'returned': {
      const a = t.agent;
      const out: Emission[] = [];
      if (t.via !== 'free_text') out.push({ bus: { type: 'agent:tool_call', agentId: a.id, tool: t.via.tool, args: t.via.args } });
      out.push({ trace: { type: 'agent:done', agentId: a.id } });
      out.push({ bus: { type: 'agent:return', agentId: a.id, result: a.result! } });
      out.push({ bus: { type: 'agent:done', agentId: a.id } });
      return out;
    }
    case 'cancelled':
      // No `agent:done`: the UI resolves straight to "cancelled" with no recovering flash.
      return [
        { trace: { type: 'pool:agentDrop', agentId: t.agent.id, reason: 'user_cancel' } },
        { bus: { type: 'agent:failed', agentId: t.agent.id, reason: 'user_cancel' } },
      ];
    case 'spawned': {
      const after = t.after && t.after.length > 0 ? { after: t.after } : {};
      return [
        { trace: { type: 'agent:spawn', agentId: t.agent.id, parentAgentId: t.agent.parentId, ...after } },
        { bus: { type: 'agent:spawn', agentId: t.agent.id, parentAgentId: t.agent.parentId, ...after } },
      ];
    }
    case 'created':
      return [{ trace: { type: 'branch:create', branchHandle: t.agent.id, parentHandle: t.agent.parentId, position: t.agent.forkHead, role: 'agentFork' } }];
    case 'formatted':
      return [{ trace: {
        type: 'prompt:format', agentId: t.agent.id, promptText: t.promptText,
        taskContent: t.taskContent, tokenCount: t.tokenCount,
        messages: JSON.stringify([
          { role: 'system', content: t.systemPrompt },
          { role: 'user', content: t.taskContent },
        ]),
        tools: t.tools, role: 'agentSuffix',
      } }];
    case 'turn':
      return [{ trace: {
        type: 'agent:turn', agentId: t.agent.id, turn: t.agent.turns,
        rawOutput: t.agent.rawOutput,
        parsedContent: t.parsed.content || null,
        parsedToolCalls: t.parsed.toolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments })),
      } }];
    case 'produced':
      return [{ bus: {
        type: 'agent:produce', agentId: t.agent.id, text: t.text, tokenCount: t.agent.tokenCount,
        ...(t.entropy !== undefined ? { entropy: t.entropy, surprisal: t.surprisal } : {}),
      } }];
    case 'recoveryProduce':
      return [{ trace: { type: 'pool:recoveryProduce', agentId: t.agent.id, tokenCount: t.tokenCount, outputLength: t.outputLength } }];
    case 'recovered':
      return [
        { bus: { type: 'agent:recovered', agentId: t.agent.id, result: t.result } },
        { trace: { type: 'pool:recoveryReturn', agentId: t.agent.id, resultLength: t.result.length } },
      ];
    case 'recoveryFailed':
      // `agent:failed` is the failure twin of `agent:recovered`: the UI leaves
      // "writing report" instead of spinning forever.
      return [
        { trace: { type: 'pool:recoveryFailed', agentId: t.agent.id, reason: t.reason, outputExcerpt: t.outputExcerpt } },
        { bus: { type: 'agent:failed', agentId: t.agent.id, reason: t.reason } },
      ];
    case 'settleFailed':
      return [
        { trace: {
          type: 'pool:settleFailed', agentId: t.agent.id, reason: t.reason,
          detail: t.detail.slice(0, 200), ...(t.rc !== undefined ? { rc: t.rc } : {}),
          ...(t.parentTraceId !== undefined ? { parentTraceId: t.parentTraceId } : {}),
        } },
        { bus: { type: 'agent:failed', agentId: t.agent.id, reason: t.reason } },
      ];
    case 'deferred':
      return [{ trace: { type: 'pool:agentDefer', agentId: t.agent.id, rc: t.rc, attempt: t.attempt, pressure: pressureRecord(t.pressure) } }];
    case 'healed':
      return [{ trace: {
        type: 'pool:agentHeal', of: t.of, agentId: t.agent.id,
        ...(t.rc !== undefined ? { rc: t.rc } : {}), attempt: t.attempt, pressure: pressureRecord(t.pressure),
      } }];
    case 'prefilled':
      return [{ trace: {
        type: 'branch:prefill', branchHandle: t.agent.id, cells: t.cells, role: t.role,
        ...(t.attachments ? { attachments: t.attachments } : {}),
        ...(t.probeText !== undefined ? { probeText: t.probeText } : {}),
      } }];
    case 'settleOrder':
      return [{ trace: { type: 'tool:settle_order', batch: t.batch } }];
    case 'pruned':
      return [{ trace: { type: 'branch:prune', branchHandle: t.agent.branch.handle, position: t.position } }];
    case 'nudged':
      return [{ trace: {
        type: 'pool:agentNudge', agentId: t.agent.id, reason: t.reason, message: t.message,
        tool: t.tool, args: t.args, ...(t.guard !== undefined ? { guard: t.guard } : {}),
      } }];
    case 'authRejected':
      return [{ trace: {
        type: 'tool:authReject', agentId: t.agent.id, assignedAbility: t.agent.assignedAbility,
        attemptedTool: t.attemptedTool, lineageHistory: t.agent.walkAncestors(x => x.toolHistory),
      } }];
    case 'toolCalled':
      return [{ bus: { type: 'agent:tool_call', agentId: t.agent.id, tool: t.tool, args: t.args } }];
    case 'dispatched':
      return [{ trace: {
        traceId: t.traceId, ts: t.ts,
        type: 'tool:dispatch', agentId: t.agent.id, tool: t.tool, toolIndex: t.toolIndex,
        toolkitSize: t.toolkitSize, args: t.args, callId: t.callId,
        explore: t.explore, percentAvailable: t.percentAvailable,
      } }];
    case 'toolTold':
      return [{ bus: {
        type: 'agent:tool_result', agentId: t.agent.id, tool: t.tool, result: t.resultStr,
        ...(t.contextAvailablePercent !== undefined ? { contextAvailablePercent: t.contextAvailablePercent } : {}),
      } }];
    case 'toolResult':
      return [{ trace: {
        ...(t.parentTraceId !== undefined ? { parentTraceId: t.parentTraceId } : {}),
        type: 'tool:result', agentId: t.agent.id, tool: t.tool, result: t.result,
        cells: t.cells, durationMs: t.durationMs,
      } }];
    case 'toolRetry':
      return [
        { bus: { type: 'agent:tool_retry', agentId: t.agent.id, tool: t.tool, retryAfterMs: t.retryAfterMs, attempt: t.attempt } },
        { trace: { parentTraceId: t.parentTraceId, type: 'tool:retry', agentId: t.agent.id, tool: t.tool, callId: t.callId, retryAfterMs: t.retryAfterMs, attempt: t.attempt } },
      ];
    case 'toolError':
      return [{ trace: { parentTraceId: t.parentTraceId, type: 'tool:error', agentId: t.agent.id, tool: t.tool, error: t.error } }];
    case 'extended':
      return [{ trace: { type: 'spine:extend', userContent: t.userContent, assistantContent: t.assistantContent, deltaTokens: t.deltaTokens, positionAfter: t.positionAfter } }];
    case 'opened':
      return [{ trace: {
        type: 'pool:open', agentCount: 0, taskSuffixTokens: [],
        pressure: { remaining: finiteOrNull(t.pressure.remaining), softLimit: t.pressure.softLimit, headroom: finiteOrNull(t.pressure.headroom) },
      } }];
    case 'closed':
      return [{ trace: {
        type: 'pool:close',
        agents: t.agents.map(a => ({ agentId: a.id, tokenCount: a.tokenCount, toolCallCount: a.toolCallCount, result: a.result, ppl: pplOf(a) })),
        totalTokens: t.agents.reduce((s, a) => s + a.tokenCount, 0),
        steps: t.steps, durationMs: t.durationMs,
      } }];
    case 'tick':
      return [
        { trace: { type: 'pool:tick', phase: 'COMMIT', activeAgents: t.activeAgents, pressure: pressureRecord(t.pressure) } },
        { bus: { type: 'agent:tick', cellsUsed: t.pressure.cellsUsed, nCtx: t.pressure.nCtx } },
      ];
    case 'kvTick':
      return [{ bus: { type: 'agent:tick', cellsUsed: t.pressure.cellsUsed, nCtx: t.pressure.nCtx } }];
    case 'paused':
      return [
        { trace: { ts: t.ts, type: 'pool:pause' } },
        { bus: { type: 'run:paused' } },
      ];
    case 'resumed':
      return [
        { trace: { type: 'pool:resume', pausedMs: t.pausedMs } },
        { bus: { type: 'run:resumed', pausedMs: t.pausedMs } },
      ];
    case 'windingDown':
      return [
        { trace: { type: 'pool:windDown' } },
        { bus: { type: 'run:windingDown' } },
      ];
  }
}

/** The one writer: projects a transition and lands its emissions in order. */
export class Emitter {
  constructor(
    private readonly tw: TraceWriter,
    private readonly channel: { send(ev: AgentEvent): Operation<void> },
    private readonly scopeId: number,
  ) {}

  *emit(t: Transition): Operation<void> {
    for (const e of project(t)) {
      if ('trace' in e) this.write(e.trace);
      else yield* this.channel.send(e.bus);
    }
  }

  /** Trace-only emission, synchronous — for records written where no
   *  operation may suspend (inside a tight sampling loop). */
  trace(t: Transition): void {
    for (const e of project(t)) {
      if ('trace' in e) this.write(e.trace);
      else throw new Error(`emit.trace: ${t.kind} projects a bus event; use emit()`);
    }
  }

  private write(body: TraceBody): void {
    const { traceId, ts, parentTraceId, ...rest } = body;
    this.tw.write({
      traceId: traceId ?? this.tw.nextId(),
      parentTraceId: parentTraceId === undefined ? this.scopeId : parentTraceId,
      ts: ts ?? performance.now(),
      ...rest,
    } as TraceEvent);
  }

  nextId(): number { return this.tw.nextId(); }
}
