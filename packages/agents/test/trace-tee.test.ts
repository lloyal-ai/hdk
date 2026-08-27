/**
 * The dev-gated trace tee — trace writes mirrored onto the bus as
 * `agent:trace`, attributed. Three contracts:
 *
 *   1. A TOOL-scoped write (the ability's own `Trace.expect().write(...)`)
 *      reaches the bus stamped with agentId + callId, and its
 *      `parentTraceId: null` is replaced by the dispatch trace id — in the
 *      FILE write too, not just the mirror.
 *   2. POOL-side intervention writes (`pool:agentNudge` here) mirror with
 *      the agentId read off the event, and the nudge now names the call it
 *      replaced (tool/args/guard).
 *   3. With a NullTraceWriter the tee is INERT: no `agent:trace` ever
 *      reaches the bus — production streams never carry mirrors.
 */
import { describe, it, expect } from 'vitest';
import { run, createChannel, scoped } from 'effection';
import type { Operation, Channel } from 'effection';
import { createMockSdk } from '../../sdk/test/MockSessionContext';
import { useAgentPool } from '../src/agent-pool';
import { parallel } from '../src/orchestrators';
import { Ctx, Store, Events, Trace } from '../src/context';
import { Tool } from '../src/Tool';
import { NullTraceWriter } from '../src/trace-writer';
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

async function runPool(writer: CapturingTraceWriter | NullTraceWriter, policy: AgentPolicy, tools: Map<string, Tool>, trace = true) {
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
        trace,
      });
      let next = yield* sub.next();
      while (!next.done) { events.push(next.value); next = yield* sub.next(); }
      return next.value;
    });
  });
  return events;
}

describe('trace tee', () => {
  it('mirrors a tool-scoped write onto the bus, attributed and re-parented', async () => {
    const writer = new CapturingTraceWriter();
    const events = await runPool(writer, toolOncePolicy(), new Map<string, Tool>([['tracing_tool', new TracingTool()]]));

    const mirrors = events.filter(e => e.type === 'agent:trace');
    const rerank = mirrors.find(m => m.type === 'agent:trace' && m.event.type === 'rerank:start');
    expect(rerank).toBeDefined();
    expect(rerank!.type === 'agent:trace' && rerank!.agentId).toBeGreaterThan(0);
    expect(rerank!.type === 'agent:trace' && rerank!.callId).toBe('call_a');
    // The stamp reaches the FILE write too — no null parents left behind.
    const fileEvent = writer.ofType('rerank:start')[0];
    expect(fileEvent.parentTraceId).not.toBeNull();
    // ...and it names the dispatch that caused it.
    const dispatch = writer.ofType('tool:dispatch')[0];
    expect(fileEvent.parentTraceId).toBe(dispatch.traceId);
  });

  it('mirrors pool-side nudges, naming the rejected call and guard', async () => {
    const writer = new CapturingTraceWriter();
    const events = await runPool(writer, toolOncePolicy((turn) => {
      if (turn === 1) return { type: 'nudge', message: 'This URL was already fetched. Try a different source.', guard: 'url_dedup' };
      return { type: 'idle', reason: 'free_text_stop' };
    }), new Map<string, Tool>([['tracing_tool', new TracingTool()]]));

    const mirror = events.find(e => e.type === 'agent:trace' && e.event.type === 'pool:agentNudge');
    expect(mirror).toBeDefined();
    const nudge = writer.ofType('pool:agentNudge')[0];
    expect(nudge.guard).toBe('url_dedup');
    expect(nudge.tool).toBe('tracing_tool');
    expect(nudge.args).toBe('{"q":"x"}');
  });

  it('is inert under NullTraceWriter — no agent:trace on the bus', async () => {
    const events = await runPool(new NullTraceWriter(), toolOncePolicy(), new Map<string, Tool>([['tracing_tool', new TracingTool()]]));
    expect(events.some(e => e.type === 'agent:trace')).toBe(false);
    // The stream itself still flowed normally.
    expect(events.some(e => e.type === 'agent:tool_result')).toBe(true);
  });

  it('a real writer WITHOUT the dev trace flag stays inert on the bus', async () => {
    const writer = new CapturingTraceWriter();
    const events = await runPool(
      writer,
      toolOncePolicy(),
      new Map<string, Tool>([['tracing_tool', new TracingTool()]]),
      false,
    );
    // the file still gets its writes — only the MIRROR is dev-gated
    expect(writer.events.length).toBeGreaterThan(0);
    expect(events.some(e => e.type === 'agent:trace')).toBe(false);
  });

  it('an already-teed ambient writer is not wrapped again (nested pools)', async () => {
    const writer = Object.assign(new CapturingTraceWriter(), {
      [Symbol.for('lloyal.traceTee')]: true,
    });
    const events = await runPool(
      writer,
      toolOncePolicy(),
      new Map<string, Tool>([['tracing_tool', new TracingTool()]]),
      true,
    );
    // the file writes still land; no SECOND mirror is minted here
    expect(writer.events.length).toBeGreaterThan(0);
    expect(events.some(e => e.type === 'agent:trace')).toBe(false);
  });
});
