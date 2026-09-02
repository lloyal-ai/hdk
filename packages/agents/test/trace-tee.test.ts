/**
 * Dispatch attribution — the pool stamps WHO a trace write belongs to into
 * the event DATA, not an envelope. Three contracts:
 *
 *   1. A TOOL-scoped write (the ability's own `Trace.expect().write(...)`)
 *      lands in the FILE stamped with the dispatching agent's `agentId`, the
 *      dispatch `callId`, and its hardcoded `parentTraceId: null` replaced
 *      by the dispatch trace id — real lineage in the record itself.
 *   2. Only-if-absent: a write that already carries attribution (a nested
 *      pool's inner stamp) keeps it; only the null parent is repaired.
 *   3. The pool bus carries NO `agent:trace` envelopes — the live mirror
 *      lives at the writer boundary (rig's `useTraceWriter`, tested there),
 *      which reads these same stamped fields.
 */
import { describe, it, expect } from 'vitest';
import { run, createChannel, scoped } from 'effection';
import type { Operation, Channel } from 'effection';
import { createMockSdk } from '../../sdk/test/MockSessionContext';
import { useAgentPool } from '../src/agent-pool';
import { parallel } from '../src/orchestrators';
import { Ctx, Store, Events, Trace } from '../src/context';
import { Tool } from '../src/Tool';
import type { AgentPolicy, ProduceAction, SettleAction } from '../src/AgentPolicy';
import type { AgentEvent, JsonSchema } from '../src/types';
import { CapturingTraceWriter } from './helpers/capturing-trace';

/** A tool that writes a trace event mid-execute, the way abilities do —
 *  including their hardcoded `parentTraceId: null`. */
class TracingTool extends Tool<{ q: string }> {
  readonly name = 'tracing_tool';
  readonly protected = false;
  readonly description = 'writes a trace event';
  readonly parameters: JsonSchema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
  *execute(): Operation<unknown> {
    const tw = yield* Trace.expect();
    tw.write({
      traceId: tw.nextId(), parentTraceId: null, ts: 1,
      type: 'rerank:start', query: 'q', chunkCount: 3, tool: 'tracing_tool',
    });
    return { ok: true };
  }
}

/** A tool whose write ALREADY carries attribution — the nested-pool shape.
 *  The dispatch tee must keep the inner stamp and repair only the parent. */
class PreStampedTool extends Tool<{ q: string }> {
  readonly name = 'tracing_tool';
  readonly protected = false;
  readonly description = 'writes a pre-attributed trace event';
  readonly parameters: JsonSchema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
  *execute(): Operation<unknown> {
    const tw = yield* Trace.expect();
    tw.write({
      traceId: tw.nextId(), parentTraceId: null, ts: 1, agentId: 777, callId: 'inner',
      type: 'rerank:start', query: 'q', chunkCount: 3, tool: 'tracing_tool',
    });
    return { ok: true };
  }
}

/** One tool-call turn, then stop. */
function toolOncePolicy(action?: (turn: number) => ProduceAction): AgentPolicy {
  let turn = 0;
  return {
    onProduced: () => {
      turn++;
      if (action) return action(turn);
      if (turn === 1) return { type: 'tool_call', tc: { name: 'tracing_tool', arguments: '{"q":"x"}', id: 'call_a' } };
      return { type: 'idle', reason: 'free_text_stop' };
    },
    onSettleReject: (): SettleAction => ({ type: 'idle', reason: 'pressure_settle_reject' }),
  };
}

async function runPool(writer: CapturingTraceWriter, policy: AgentPolicy, tools: Map<string, Tool>) {
  const { ctx, store, root } = createMockSdk({ nCtx: 16384, cellsUsed: 1000 });
  // Every turn parses as one tracing_tool call — the PRODUCE nudge path reads
  // the parsed call to name the rejected tool on the trace event.
  ctx.parseChatOutput = (() => ({
    content: null,
    toolCalls: [{ name: 'tracing_tool', arguments: '{"q":"x"}', id: 'call_a' }],
  })) as any;
  await root.prefill(ctx.tokenizeSync('system prompt'));
  const events: AgentEvent[] = [];
  await run(function* () {
    yield* Ctx.set(ctx as any);
    yield* Store.set(store);
    const ch: Channel<AgentEvent, void> = createChannel();
    yield* Events.set(ch as any);
    yield* Trace.set(writer);
    return yield* scoped(function* () {
      const sub = yield* useAgentPool({
        spine: root,
        orchestrate: parallel([{ content: 'Task', systemPrompt: 'You are an agent.', seed: 1 }]),
        toolsJson: tools.size ? JSON.stringify([...tools.values()].map(t => t.schema)) : '',
        tools,
        policy,
        maxTurns: 10,
      });
      let next = yield* sub.next();
      while (!next.done) { events.push(next.value); next = yield* sub.next(); }
      return next.value;
    });
  });
  return events;
}

describe('dispatch attribution', () => {
  it('stamps a tool-scoped write with agent, call, and dispatch lineage — in the file', async () => {
    const writer = new CapturingTraceWriter();
    await runPool(writer, toolOncePolicy(), new Map<string, Tool>([['tracing_tool', new TracingTool()]]));

    const fileEvent = writer.ofType('rerank:start')[0];
    expect(fileEvent).toBeDefined();
    expect(fileEvent.agentId).toBeGreaterThan(0);
    expect(fileEvent.callId).toBe('call_a');
    // No null parents left behind — the stamp names the dispatch that caused it.
    const dispatch = writer.ofType('tool:dispatch')[0];
    expect(fileEvent.parentTraceId).toBe(dispatch.traceId);
  });

  it('keeps inner attribution (nested-pool shape); repairs only the parent', async () => {
    const writer = new CapturingTraceWriter();
    await runPool(writer, toolOncePolicy(), new Map<string, Tool>([['tracing_tool', new PreStampedTool()]]));

    const fileEvent = writer.ofType('rerank:start')[0];
    expect(fileEvent.agentId).toBe(777);
    expect(fileEvent.callId).toBe('inner');
    expect(fileEvent.parentTraceId).toBe(writer.ofType('tool:dispatch')[0].traceId);
  });

  it('stamps pool-side nudges with their agent, naming the rejected call and guard', async () => {
    const writer = new CapturingTraceWriter();
    await runPool(writer, toolOncePolicy((turn) => {
      if (turn === 1) return { type: 'nudge', message: 'This URL was already fetched. Try a different source.', guard: 'url_dedup' };
      return { type: 'idle', reason: 'free_text_stop' };
    }), new Map<string, Tool>([['tracing_tool', new TracingTool()]]));

    const nudge = writer.ofType('pool:agentNudge')[0];
    expect(nudge).toBeDefined();
    expect(nudge.guard).toBe('url_dedup');
    expect(nudge.tool).toBe('tracing_tool');
    expect(nudge.args).toBe('{"q":"x"}');
  });

  it('the pool bus carries no agent:trace — the mirror lives at the writer boundary', async () => {
    const events = await runPool(new CapturingTraceWriter(), toolOncePolicy(), new Map<string, Tool>([['tracing_tool', new TracingTool()]]));
    expect(events.some(e => e.type === 'agent:trace')).toBe(false);
    // The stream itself still flowed normally.
    expect(events.some(e => e.type === 'agent:tool_result')).toBe(true);
  });
});
