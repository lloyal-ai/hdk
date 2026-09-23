/**
 * `agentPool({ schema })`: the schema constrains what every agent generates, and nothing more — what
 * `useAgent({ schema })` does for one agent. It is compiled once and installed on each agent in place of the
 * tool-call grammar. Whether an answer is kept, and whether an agent reasons first, stay the caller's options.
 */
import { describe, it, expect } from 'vitest';
import { run, createChannel, createSignal, spawn } from 'effection';
import type { Channel } from 'effection';
import { GrammarTriggerType } from '@lloyal-labs/sdk';
import { createMockSdk } from '../../sdk/src/testing.js';
import { agentPool } from '../src/create-agent-pool';
import { parallel } from '../src/orchestrators';
import { Ctx, Store, Events, Trace, Attachments, Ingress, WindDown, CancelAgent } from '../src/context';
import { DefaultAgentPolicy } from '../src/AgentPolicy';
import type { AgentPolicy } from '../src/AgentPolicy';
import type { Tool } from '../src/Tool';
import type { AgentEvent, AgentPoolResult, JsonSchema } from '../src/types';
import { MemoryAttachmentStore } from './helpers/memory-store';
import { rawIngress } from './helpers/raw-ingress';
import { CapturingTraceWriter } from './helpers/capturing-trace';
import { MockTool } from './helpers/mock-tool';

const SCHEMA: JsonSchema = { type: 'integer', minimum: 0 };
const TOOL_GRAMMAR = 'root ::= tool-call';
const AGENTS = 3;
/** The token every agent samples once before it stops; the mock renders it `t7`. */
const ANSWER = 7;

interface Seen {
  /** Every schema the pool asked to compile. */
  compiled: string[];
  /** Branches handed an eager grammar, and which. */
  eager: Map<number, string>;
  /** Branches handed the lazy tool-call grammar. */
  lazy: number[];
  /** Branches made after the fixture: the spine and every fork. */
  made: number;
  /** Whether each chat format — the spine's header, every agent's suffix — was asked for a reasoning block. */
  thinking: (boolean | undefined)[];
}

interface Asked {
  schema?: JsonSchema;
  tools?: Tool[];
  enableThinking?: boolean;
  acceptFreeText?: boolean;
  policy?: AgentPolicy;
  refuseSchema?: boolean;
  /** The first agent to sample never stops, and is cancelled on its first token or wound down once its
   *  siblings have returned. */
  interrupt?: 'cancel' | 'windDown';
}

async function pool(asked: Asked): Promise<{ result: AgentPoolResult | null; error: Error | null; seen: Seen }> {
  const { ctx, store } = createMockSdk({ nCtx: 16384, cellsUsed: 0 });
  const seen: Seen = { compiled: [], eager: new Map(), lazy: [], made: 0, thinking: [] };

  ctx.jsonSchemaToGrammar = async (schema: string) => {
    seen.compiled.push(schema);
    if (asked.refuseSchema) throw new Error('unsupported schema');
    return `grammar of ${schema}`;
  };
  // A template that calls tools: its format carries a lazy grammar, triggered by the call's opening.
  const format = ctx.formatChatSync.bind(ctx);
  ctx.formatChatSync = (msgs, fmtOpts) => {
    seen.thinking.push(typeof fmtOpts === 'object' ? fmtOpts?.enableThinking : undefined);
    return {
      ...format(msgs, fmtOpts),
      grammar: TOOL_GRAMMAR,
      grammarLazy: true,
      grammarTriggers: [{ type: GrammarTriggerType.WORD, value: '<tool_call>', token: -1 }],
    };
  };
  ctx._branchSetGrammar = (handle, grammar) => { seen.eager.set(handle, grammar); };
  ctx._branchSetGrammarLazy = (handle) => { seen.lazy.push(handle); };
  const create = ctx._branchCreate.bind(ctx);
  ctx._branchCreate = (...args) => { seen.made++; return create(...args); };
  const fork = ctx._branchFork.bind(ctx);
  ctx._branchFork = (parent) => { seen.made++; return fork(parent); };
  let unending: number | null = null;
  const sampled = new Set<number>();
  ctx._branchSample = (handle) => {
    if (asked.interrupt && unending === null) unending = handle;
    if (handle === unending) return ANSWER;
    if (sampled.has(handle)) return ctx.stopToken;
    sampled.add(handle);
    return ANSWER;
  };

  let result: AgentPoolResult | null = null;
  let error: Error | null = null;
  await run(function* () {
    yield* Ctx.set(ctx as never);
    yield* Store.set(store);
    const events: Channel<AgentEvent, void> = createChannel();
    yield* Events.set(events as never);
    yield* Trace.set(new CapturingTraceWriter());
    const content = new MemoryAttachmentStore();
    yield* Attachments.set(content);
    yield* Ingress.set(rawIngress(content));
    const windDown = createSignal<void, void>();
    const cancel = createSignal<{ agentId: number }, void>();
    if (asked.interrupt === 'windDown') yield* WindDown.set(windDown);
    if (asked.interrupt === 'cancel') yield* CancelAgent.set(cancel);
    const heard = yield* events;
    yield* spawn(function* () {
      let returned = 0;
      for (;;) {
        const next = yield* heard.next();
        if (next.done) return;
        const ev = next.value;
        if (asked.interrupt === 'cancel' && ev.type === 'agent:produce' && ev.agentId === unending) {
          cancel.send({ agentId: ev.agentId });
          return;
        }
        if (asked.interrupt === 'windDown' && ev.type === 'agent:return' && ++returned === AGENTS - 1) {
          windDown.send();
          return;
        }
      }
    });
    try {
      result = yield* agentPool({
        systemPrompt: 'Answer with a number.',
        tools: asked.tools,
        schema: asked.schema,
        enableThinking: asked.enableThinking,
        acceptFreeText: asked.acceptFreeText,
        policy: asked.policy,
        orchestrate: parallel(Array.from({ length: AGENTS }, (_, i) => ({ key: `a${i}`, systemPrompt: '', content: `item ${i}` }))),
      });
    } catch (e) {
      error = e as Error;
    }
  });
  return { result, error, seen };
}

const agentHandles = (r: AgentPoolResult | null): number[] => (r?.agents ?? []).map((a) => a.agentId);
const results = (r: AgentPoolResult | null) => Array.from({ length: AGENTS }, (_, i) => r?.byKey(`a${i}`)?.result ?? null);

describe('agentPool with a schema', () => {
  it('compiles the schema once and puts every agent under that grammar, not the tool-call one', async () => {
    const { result, seen } = await pool({ schema: SCHEMA });
    const handles = agentHandles(result);
    expect(handles).toHaveLength(AGENTS);
    expect(seen.compiled).toEqual([JSON.stringify(SCHEMA)]);
    for (const h of handles) expect(seen.eager.get(h)).toBe(`grammar of ${JSON.stringify(SCHEMA)}`);
    expect(seen.lazy).toEqual([]);
  });

  it('wins over the tool-call grammar when the pool also has a tool', async () => {
    const { result, seen } = await pool({ schema: SCHEMA, tools: [new MockTool('lookup')] });
    for (const h of agentHandles(result)) expect(seen.eager.has(h)).toBe(true);
    expect(seen.lazy).toEqual([]);
  });

  it('keeps no answer it was not asked to keep', async () => {
    const { result, error } = await pool({ schema: SCHEMA });
    expect(error).toBeNull();
    expect(results(result)).toEqual([null, null, null]);
  });

  it('keeps each answer when asked to, as any pool keeps prose', async () => {
    const { result } = await pool({ schema: SCHEMA, acceptFreeText: true, enableThinking: false });
    expect(results(result)).toEqual([`t${ANSWER}`, `t${ANSWER}`, `t${ANSWER}`]);
  });

  it('formats with a reasoning block as the pool is told, defaulting as any pool does', async () => {
    const unasked = await pool({ schema: SCHEMA });
    expect(unasked.seen.thinking).toHaveLength(1 + AGENTS);
    expect(unasked.seen.thinking.every((t) => t === true)).toBe(true);

    const off = await pool({ schema: SCHEMA, enableThinking: false });
    expect(off.seen.thinking.every((t) => t === false)).toBe(true);
  });

  it.each([
    ['to reason first', { enableThinking: true }],
    ['not to keep its answer', { acceptFreeText: false }],
  ])('takes a schema beside being asked %s, as it takes any pool option', async (_, asked) => {
    const { result, error } = await pool({ schema: SCHEMA, ...asked });
    expect(error).toBeNull();
    expect(agentHandles(result)).toHaveLength(AGENTS);
  });

  it('leaves keeping the answer to a policy of the caller\'s own', async () => {
    const { result } = await pool({ schema: SCHEMA, policy: new DefaultAgentPolicy({ acceptFreeText: true }) });
    expect(results(result)).toEqual([`t${ANSWER}`, `t${ANSWER}`, `t${ANSWER}`]);
  });

  it('refuses a policy beside pool policy options, as it always has', async () => {
    const { result, error } = await pool({ schema: SCHEMA, policy: new DefaultAgentPolicy(), acceptFreeText: true });
    expect(error?.message).toMatch(/not both/);
    expect(result).toBeNull();
  });

  it('refuses before any branch is made when the schema will not compile', async () => {
    const { result, error, seen } = await pool({ schema: SCHEMA, refuseSchema: true });
    expect(error?.message).toBe('unsupported schema');
    expect(result).toBeNull();
    expect(seen.made).toBe(0);
  });
});

describe('agentPool with a schema, when an agent does not finish', () => {
  it('keeps the answers that finished and none from an agent cancelled mid-answer', async () => {
    const { result } = await pool({ schema: SCHEMA, acceptFreeText: true, enableThinking: false, interrupt: 'cancel' });
    const cancelled = result!.outcomes.find((o) => o.failed === 'user_cancel');
    expect(cancelled?.result).toBeNull();
    expect(result!.outcomes.filter((o) => o !== cancelled).map((o) => o.result)).toEqual([`t${ANSWER}`, `t${ANSWER}`]);
  });

  it('keeps the answers that finished and none from an agent wound down mid-answer', async () => {
    const { result } = await pool({ schema: SCHEMA, acceptFreeText: true, enableThinking: false, interrupt: 'windDown' });
    expect(result!.outcomes.map((o) => o.result).filter((r) => r === null)).toHaveLength(1);
    expect(result!.outcomes.map((o) => o.result).filter((r) => r !== null)).toEqual([`t${ANSWER}`, `t${ANSWER}`]);
  });
});

describe('agentPool without a schema', () => {
  it('compiles nothing and leaves a pool with a tool on the tool-call grammar', async () => {
    const { result, seen } = await pool({ tools: [new MockTool('lookup')] });
    expect(seen.compiled).toEqual([]);
    expect(seen.eager.size).toBe(0);
    expect(seen.lazy.sort()).toEqual(agentHandles(result).sort());
  });

  it('installs no grammar at all on a pool with no tool', async () => {
    const { seen } = await pool({});
    expect(seen.compiled).toEqual([]);
    expect(seen.eager.size).toBe(0);
    expect(seen.lazy).toEqual([]);
  });

  it('keeps prose only when asked, and reasons as the pool is told', async () => {
    const unasked = await pool({});
    expect(results(unasked.result)).toEqual([null, null, null]);
    expect(unasked.seen.thinking.every((t) => t === true)).toBe(true);

    const asked = await pool({ acceptFreeText: true, enableThinking: false });
    expect(results(asked.result)).toEqual([`t${ANSWER}`, `t${ANSWER}`, `t${ANSWER}`]);
    expect(asked.seen.thinking.every((t) => t === false)).toBe(true);
  });
});
