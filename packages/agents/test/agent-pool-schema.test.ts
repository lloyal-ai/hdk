/**
 * `agentPool({ schema })`: every agent's answer takes the schema's shape. The schema is compiled once and installed
 * on each agent in place of the tool-call grammar; the answer is the agent's result, and nothing reasons before it.
 */
import { describe, it, expect } from 'vitest';
import { run, createChannel } from 'effection';
import type { Channel } from 'effection';
import { GrammarTriggerType } from '@lloyal-labs/sdk';
import { createMockSdk } from '../../sdk/src/testing.js';
import { agentPool } from '../src/create-agent-pool';
import { parallel } from '../src/orchestrators';
import { Ctx, Store, Events, Trace, Attachments, Ingress } from '../src/context';
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

interface Asked { schema?: JsonSchema; tools?: Tool[]; enableThinking?: boolean; acceptFreeText?: boolean; refuseSchema?: boolean }

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
  const sampled = new Set<number>();
  ctx._branchSample = (handle) => {
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
    try {
      result = yield* agentPool({
        systemPrompt: 'Answer with a number.',
        tools: asked.tools,
        schema: asked.schema,
        enableThinking: asked.enableThinking,
        acceptFreeText: asked.acceptFreeText,
        orchestrate: parallel(Array.from({ length: AGENTS }, (_, i) => ({ key: `a${i}`, systemPrompt: '', content: `item ${i}` }))),
      });
    } catch (e) {
      error = e as Error;
    }
  });
  return { result, error, seen };
}

const agentHandles = (r: AgentPoolResult | null): number[] => (r?.agents ?? []).map((a) => a.agentId);

describe('agentPool with a schema', () => {
  it('compiles the schema once and puts every agent under that grammar, not the tool-call one', async () => {
    const { result, seen } = await pool({ schema: SCHEMA });
    const handles = agentHandles(result);
    expect(handles).toHaveLength(AGENTS);
    expect(seen.compiled).toEqual([JSON.stringify(SCHEMA)]);
    for (const h of handles) expect(seen.eager.get(h)).toBe(`grammar of ${JSON.stringify(SCHEMA)}`);
    expect(seen.lazy).toEqual([]);
  });

  it('keeps each agent\'s answer as its result without being asked to', async () => {
    const { result } = await pool({ schema: SCHEMA });
    for (let i = 0; i < AGENTS; i++) expect(result!.byKey(`a${i}`)?.result).toBe(`t${ANSWER}`);
  });

  it('formats the spine and every agent with no reasoning block', async () => {
    const { seen } = await pool({ schema: SCHEMA });
    expect(seen.thinking).toHaveLength(1 + AGENTS);
    expect(seen.thinking.every((t) => t === false)).toBe(true);
  });

  it('wins over the tool-call grammar when the pool also has a tool', async () => {
    const { result, seen } = await pool({ schema: SCHEMA, tools: [new MockTool('lookup')] });
    for (const h of agentHandles(result)) expect(seen.eager.has(h)).toBe(true);
    expect(seen.lazy).toEqual([]);
  });

  it.each([
    ['asked to reason first', { enableThinking: true }],
    ['asked not to keep its answer', { acceptFreeText: false }],
  ])('refuses a schema %s, before anything is compiled or made', async (_, contradiction) => {
    const { result, error, seen } = await pool({ schema: SCHEMA, ...contradiction });
    expect(error?.message).toMatch(/schema answer is the agent's result/);
    expect(result).toBeNull();
    expect(seen.compiled).toEqual([]);
    expect(seen.made).toBe(0);
  });

  it('refuses before any branch is made when the schema will not compile', async () => {
    const { result, error, seen } = await pool({ schema: SCHEMA, refuseSchema: true });
    expect(error?.message).toBe('unsupported schema');
    expect(result).toBeNull();
    expect(seen.made).toBe(0);
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
    for (let i = 0; i < AGENTS; i++) expect(unasked.result!.byKey(`a${i}`)?.result).toBeNull();
    expect(unasked.seen.thinking.every((t) => t === true)).toBe(true);

    const asked = await pool({ acceptFreeText: true, enableThinking: false });
    for (let i = 0; i < AGENTS; i++) expect(asked.result!.byKey(`a${i}`)?.result).toBe(`t${ANSWER}`);
    expect(asked.seen.thinking.every((t) => t === false)).toBe(true);
  });
});
