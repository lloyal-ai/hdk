/**
 * C3: the terminal call is captured at ONE site through ONE extractor, and the
 * tool that ends the turn has the first say about it. `onReturn` is the fifth
 * position of the tool lifecycle: the tool validates what the model submitted
 * and either accepts it (with the string the agent's result becomes) or asks
 * rejects it — a nudge, bounded to one per agent, so an exhausted context is
 * never spent on retries. The frame's default accepts the policy's capture.
 * `acceptFreeText` makes prose the result with no tool calls. A tool that
 * throws fails the agent instead of returning the error as findings.
 */
import { describe, it, expect } from 'vitest';
import { run, createChannel, scoped } from 'effection';
import type { Channel, Operation } from 'effection';
import type { ParsedToolCall } from '@lloyal-labs/sdk';
import { createMockSdk } from '../../sdk/src/testing.js';
import type { MockSessionContext } from '../../sdk/src/testing.js';
import { useAgentPool } from '../src/agent-pool';
import { useAgent } from '../src/use-agent';
import { parallel } from '../src/orchestrators';
import { Ctx, Store, Events, Trace, Attachments, Ingress } from '../src/context';
import { DefaultAgentPolicy } from '../src/AgentPolicy';
import type { AgentPolicy } from '../src/AgentPolicy';
import { Tool } from '../src/Tool';
import type { ToolLifecycleHooks } from '../src/Tool';
import { ContextPressure } from '../src/pressure';
import type { Agent } from '../src/Agent';
import type { AgentEvent, AgentPoolResult, JsonSchema } from '../src/types';
import { MemoryAttachmentStore } from './helpers/memory-store';
import { rawIngress } from './helpers/raw-ingress';
import { CapturingTraceWriter } from './helpers/capturing-trace';

const STOP = 999;
const pressureAt = (percentAvailable: number): ContextPressure =>
  ({ critical: false, percentAvailable, headroom: 10_000, remaining: 20_000, hardLimit: 512, softLimit: 1024, canFit: () => true } as unknown as ContextPressure);
const agentWith = (over: Partial<{ currentTool: string | null; turns: number; toolCallCount: number; result: string | null }>): Agent =>
  ({ startedAt: 0, currentTool: null, turns: 0, toolCallCount: 0, result: null, tokenCount: 0, ...over } as unknown as Agent);
const call = (name: string, args: unknown): ParsedToolCall => ({ id: 'c1', name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
const CFG = { maxTurns: 10, terminalToolName: 'submit' };

/** A terminal tool that insists on a `city` field: reject until it is there. */
class Submit extends Tool<{ city?: string }> {
  readonly name = 'submit';
  readonly description = 'submit the row';
  readonly parameters: JsonSchema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
  rejections = 0;
  constructor(private readonly always = false) { super(); }
  readonly hooks: ToolLifecycleHooks = {
    onReturn: ({ args, raw }) => {
      if (this.always || typeof args.city !== 'string') { this.rejections++; return { type: 'reject', message: 'submit needs a city' }; }
      return { type: 'accept', result: `city=${args.city} (${raw.length} bytes)` };
    },
  };
  *execute(): Operation<unknown> { return {}; }
}

interface World { ctx: MockSessionContext; root: ReturnType<typeof createMockSdk>['root']; store: ReturnType<typeof createMockSdk>['store']; trace: CapturingTraceWriter; events: AgentEvent[] }

/** Every turn stops after one token; the n-th turn of a fork parses as `turns[n]`. */
async function world(turns: (handle: number, turn: number) => { content: string; toolCalls: ParsedToolCall[] }): Promise<World> {
  const { ctx, store, root } = createMockSdk({ nCtx: 16384 });
  await root.prefill(ctx.tokenizeSync('system prompt'));
  const seen = new Map<number, number>();
  let last = 0;
  ctx._branchSample = (handle: number): number => {
    last = handle;
    const n = seen.get(handle) ?? 0;
    seen.set(handle, n + 1);
    return n % 2 === 0 ? 7 : STOP;   // one token, then stop, each turn
  };
  const turnOf = new Map<number, number>();
  ctx.parseChatOutput = (_o, _f, o) => {
    if (o?.isPartial) return { content: '', reasoningContent: '', toolCalls: [] };
    const t = turnOf.get(last) ?? 0;
    turnOf.set(last, t + 1);
    return { reasoningContent: '', ...turns(last, t) };
  };
  return { ctx, root, store, trace: new CapturingTraceWriter(), events: [] };
}

function* contexts(w: World): Operation<void> {
  yield* Ctx.set(w.ctx as never);
  yield* Store.set(w.store);
  const events: Channel<AgentEvent, void> = createChannel();
  yield* Events.set(events as never);
  yield* Trace.set(w.trace);
  const contentStore = new MemoryAttachmentStore();
  yield* Attachments.set(contentStore);
  yield* Ingress.set(rawIngress(contentStore));
}

function* pool(w: World, opts: Partial<Parameters<typeof useAgentPool>[0]>): Operation<AgentPoolResult> {
  return yield* scoped(function* () {
    const sub = yield* useAgentPool({ spine: w.root, toolsJson: '', tools: new Map(), maxTurns: 10, orchestrate: parallel([{ content: 'row', systemPrompt: 's' }]), ...opts } as Parameters<typeof useAgentPool>[0]);
    let next = yield* sub.next();
    while (!next.done) { w.events.push(next.value); next = yield* sub.next(); }
    return next.value;
  });
}

describe('the return action', () => {
  it('carries the terminal call, and its result comes from the one extractor', () => {
    const policy = new DefaultAgentPolicy();
    const tc = call('submit', { result: 'r', extra: 1 });
    expect(policy.onProduced(agentWith({}), { content: null, toolCalls: [tc] }, pressureAt(80), CFG)).toEqual({ type: 'return', result: 'r', call: tc });
    // No `result` field: the raw arguments are the result — the same rule recovery reads by.
    const structured = call('submit', { city: 'Oslo' });
    expect(policy.onProduced(agentWith({}), { content: null, toolCalls: [structured] }, pressureAt(80), CFG)).toEqual({ type: 'return', result: structured.arguments, call: structured });
  });

  it('bindTerminal binds the pool\'s terminal to the policy: an agent mid-call is protected from the exit', () => {
    const policy = new DefaultAgentPolicy({ budget: { time: { hardLimit: 1 } } });
    let t = 0; policy.bindClock(() => t); t = 5;
    expect(policy.shouldExit(agentWith({ currentTool: 'submit' }), pressureAt(80))).toBe(true);
    policy.bindTerminal('submit');
    expect(policy.shouldExit(agentWith({ currentTool: 'submit' }), pressureAt(80))).toBe(false);
  });

  it('acceptFreeText makes prose the result with no tool calls; without it prose is an idle stop', () => {
    const parsed = { content: 'the answer', toolCalls: [] as ParsedToolCall[] };
    expect(new DefaultAgentPolicy().onProduced(agentWith({}), parsed, pressureAt(80), CFG)).toEqual({ type: 'idle', reason: 'free_text_stop' });
    expect(new DefaultAgentPolicy({ acceptFreeText: true }).onProduced(agentWith({}), parsed, pressureAt(80), CFG)).toEqual({ type: 'free_text_return', content: 'the answer' });
  });
});

describe('onReturn: the terminal tool decides its capture', () => {
  it('a harness floor is an onReturn contribution on the policy: it refuses a first-action terminal call once, before the typed output\'s accept; the accept then stands', async () => {
    const submit = new Submit();
    const floor: ToolLifecycleHooks = { onReturn: ({ agent }) => (agent.toolCallCount < 1 ? { type: 'reject', message: 'use a tool first' } : undefined) };
    const w = await world(() => ({ content: '', toolCalls: [call('submit', { city: 'Oslo' })] }));
    const result = await run(function* () {
      yield* contexts(w);
      return yield* pool(w, { tools: new Map([['submit', submit]]), toolsJson: JSON.stringify([submit.schema]), terminalToolName: 'submit', hooks: [floor] });
    });
    expect(w.trace.ofType('pool:agentNudge').map((n) => n.message)).toEqual(['use a tool first']);
    expect(submit.rejections).toBe(0);
    expect(result.outcomes[0].result).toBe(`city=Oslo (${JSON.stringify({ city: 'Oslo' }).length} bytes)`);
  });

  it('the frame\'s bound: no rejection at the turn cap — the tool is asked, its rejection is not issued, the policy\'s capture stands', async () => {
    const submit = new Submit(true);
    const w = await world(() => ({ content: '', toolCalls: [call('submit', { town: 'Oslo' })] }));
    const result = await run(function* () {
      yield* contexts(w);
      return yield* pool(w, { tools: new Map([['submit', submit]]), toolsJson: JSON.stringify([submit.schema]), terminalToolName: 'submit', maxTurns: 0 });
    });
    expect(submit.rejections).toBe(1);
    expect(w.trace.ofType('pool:agentNudge')).toEqual([]);
    expect(result.outcomes[0].result).toBe(JSON.stringify({ town: 'Oslo' }));
  });

  it('a rejection nudges the model once with the tool\'s message; the call that comes back is accepted with the tool\'s result', async () => {
    const submit = new Submit();
    const w = await world((_h, turn) => turn === 0
      ? { content: '', toolCalls: [call('submit', { town: 'Oslo' })] }
      : { content: '', toolCalls: [call('submit', { city: 'Oslo' })] });
    const result = await run(function* () {
      yield* contexts(w);
      return yield* pool(w, { tools: new Map([['submit', submit]]), toolsJson: JSON.stringify([submit.schema]), terminalToolName: 'submit' });
    });
    expect(submit.rejections).toBe(1);
    expect(w.trace.ofType('pool:agentNudge').map((n) => n.message)).toEqual(['submit needs a city']);
    expect(result.outcomes[0].result).toBe(`city=Oslo (${JSON.stringify({ city: 'Oslo' }).length} bytes)`);
    expect(result.agents[0].agent.returnsRejected).toBe(1);
  });

  it('rejection is bounded to one: a second is not issued and the policy\'s capture stands', async () => {
    const submit = new Submit(true);
    const w = await world(() => ({ content: '', toolCalls: [call('submit', { town: 'Oslo' })] }));
    const result = await run(function* () {
      yield* contexts(w);
      return yield* pool(w, { tools: new Map([['submit', submit]]), toolsJson: JSON.stringify([submit.schema]), terminalToolName: 'submit' });
    });
    expect(submit.rejections).toBe(2);
    expect(w.trace.ofType('pool:agentNudge')).toHaveLength(1);
    expect(result.outcomes[0].result).toBe(JSON.stringify({ town: 'Oslo' }));
  });

  it('a tool without an opinion leaves the policy\'s capture standing', async () => {
    class Plain extends Tool { readonly name = 'submit'; readonly description = 'd'; readonly parameters: JsonSchema = { type: 'object', properties: {} }; *execute(): Operation<unknown> { return {}; } }
    const w = await world(() => ({ content: '', toolCalls: [call('submit', { result: 'findings', sources: [] })] }));
    const result = await run(function* () {
      yield* contexts(w);
      return yield* pool(w, { tools: new Map([['submit', new Plain()]]), toolsJson: '[]', terminalToolName: 'submit' });
    });
    expect(result.outcomes[0].result).toBe('findings');
  });
});

describe('acceptFreeText end to end, and a tool that throws', () => {
  it('useAgent({ acceptFreeText }) returns the prose as the result with no tool calls', async () => {
    const w = await world(() => ({ content: 'forty-two', toolCalls: [] }));
    const result = await run(function* () {
      yield* contexts(w);
      return yield* scoped(function* () {
        const a = yield* useAgent({ systemPrompt: 's', task: 't', acceptFreeText: true });
        return a.result;
      });
    });
    expect(result).toBe('forty-two');
  });

  it('a tool that throws fails the agent — agent:failed with tool_error, no result — instead of returning the error as findings', async () => {
    class Explode extends Tool { readonly name = 'explode'; readonly description = 'd'; readonly parameters: JsonSchema = { type: 'object', properties: {} }; *execute(): Operation<unknown> { throw new Error('boom'); } }
    const policy: AgentPolicy = {
      onProduced: (_a, parsed) => parsed.toolCalls.length > 0 ? { type: 'tool_call', tc: parsed.toolCalls[0] } : { type: 'idle', reason: 'free_text_stop' },
      shouldExit: () => false,
    };
    const w = await world(() => ({ content: '', toolCalls: [call('explode', {})] }));
    const result = await run(function* () {
      yield* contexts(w);
      return yield* pool(w, { tools: new Map([['explode', new Explode()]]), toolsJson: '[]', policy });
    });
    expect(result.outcomes[0]).toMatchObject({ result: null, failed: 'tool_error' });
    expect(w.events.filter((e) => e.type === 'agent:failed')).toEqual([expect.objectContaining({ reason: 'tool_error' })]);
    expect(w.trace.ofType('tool:error').map((e) => e.error)).toEqual(['boom']);
  });
});
