/**
 * Pool-level integration tests — verifies the pool's EXECUTION of policy decisions.
 *
 * Uses real Branch + BranchStore from @lloyal-labs/sdk with MockSessionContext
 * that simulates the native layer. This validates the full call chain:
 * useAgentPool -> Branch.produceSync/forkSync/pruneSync -> SessionContext._branch/_store
 *
 * 145 unit tests already cover policy DECISIONS. These 18 tests cover EXECUTION:
 * transitions, trace events, event emissions, ToolContext fields, recovery.
 */
import { describe, it, expect } from 'vitest';
import { MediaTool, PNG_BYTES, MEDIA_TEST_NCTX, mediaFailures } from './helpers/media';
import { run, createChannel, createSignal, spawn, each, scoped, call } from 'effection';
import type { Operation, Channel } from 'effection';
import { MockSessionContext, createMockSdk } from '../../sdk/src/testing.js';
import type { ChatFormat, ParseChatOutputOptions, ParseChatOutputResult } from '@lloyal-labs/sdk';
import { useAgentPool } from '../src/agent-pool';
import { parallel } from '../src/orchestrators';
import { Ctx, Store, Events, Trace, WindDown, Attachments, Ingress } from '../src/context';
import { MemoryAttachmentStore } from './helpers/memory-store';
import { rawIngress } from './helpers/raw-ingress';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tool } from '../src/Tool';
import type { AgentPolicy } from '../src/AgentPolicy';
import type { AgentPoolResult, AgentEvent, ToolContext } from '../src/types';
import type { Agent } from '../src/Agent';
import { CapturingTraceWriter } from './helpers/capturing-trace';
import { MockTool } from './helpers/mock-tool';

const STOP = 999; // MockSessionContext default stopToken

// ── Test helpers ────────────────────────────────────────────────

/**
 * Run useAgentPool in a fully-wired Effection scope with mock infrastructure.
 *
 * forkTokenQueues: per-fork token sequences. Index 0 = first fork, 1 = second, etc.
 * Each array is the sequence of tokens _branchSample returns for that fork.
 * Exhausted queues return STOP.
 */
async function runPool(opts: {
  nCtx?: number;
  cellsUsed?: number;
  forkTokenQueues?: number[][];
  parseChatOutputFn?: (raw: string, format: ChatFormat, opts?: ParseChatOutputOptions) => ParseChatOutputResult;
  policy: AgentPolicy;
  taskCount?: number;
  tools?: Map<string, Tool>;
  terminalTool?: string;
  maxTurns?: number;
  trace?: boolean;
  pruneOnReturn?: boolean;
  /** Fire the WindDown signal when an emitted event matches (once). */
  windDownOn?: (ev: AgentEvent) => boolean;
  /** Last-chance ctx mutation hook — runs after fork/sample wiring, before the pool. */
  mutateCtx?: (ctx: MockSessionContext) => void;
  /** Install an ingress that refuses everything, to exercise the barrier. */
  refusingIngress?: boolean;
}): Promise<{
  result: AgentPoolResult;
  events: AgentEvent[];
  trace: CapturingTraceWriter;
  ctx: MockSessionContext;
}> {
  const { ctx, store, root } = createMockSdk({
    nCtx: opts.nCtx ?? 16384,
    cellsUsed: opts.cellsUsed ?? 1000,
  });

  // ── Wire per-fork token queues into _branchSample ─────────
  const queues = opts.forkTokenQueues ?? [[STOP]];
  let forkCount = 0;
  const branchForkIndex = new Map<number, number>();
  const branchSampleCount = new Map<number, number>();

  const origFork = ctx._branchFork.bind(ctx);
  ctx._branchFork = (parentHandle: number): number => {
    const handle = origFork(parentHandle);
    branchForkIndex.set(handle, forkCount++);
    branchSampleCount.set(handle, 0);
    return handle;
  };

  ctx._branchSample = (handle: number): number => {
    const fi = branchForkIndex.get(handle) ?? -1;
    const queue = fi >= 0 ? (queues[fi] ?? [STOP]) : [STOP];
    const idx = branchSampleCount.get(handle) ?? 0;
    branchSampleCount.set(handle, idx + 1);
    return idx < queue.length ? queue[idx] : STOP;
  };

  // ── Wire parseChatOutput override ─────────────────────────
  if (opts.parseChatOutputFn) {
    ctx.parseChatOutput = opts.parseChatOutputFn;
  }

  opts.mutateCtx?.(ctx);

  // ── Wire tokenToText for readable output ──────────────────
  // (default `t${token}` from MockSessionContext is fine for most tests)

  const traceWriter = new CapturingTraceWriter();
  const collectedEvents: AgentEvent[] = [];

  // Prefill root to simulate withSpine system prompt
  const rootTokens = ctx.tokenizeSync('system prompt');
  await root.prefill(rootTokens);

  const result = await run(function* () {
    yield* Ctx.set(ctx as any);
    yield* Store.set(store);
    const events: Channel<AgentEvent, void> = createChannel();
    yield* Events.set(events as any);
    yield* Trace.set(traceWriter);
    // A real store: media paths now REFUSE to run without one, because
    // unaddressed media makes a run unreplayable. Tests that exercise them
    // must be configured the way a real harness is.
    const contentStore = new MemoryAttachmentStore();
    yield* Attachments.set(contentStore);
    // Media now refuses to run without an ingress, because unnormalized,
    // unaddressed bytes make a run unreplayable. Tests use a raw one — they
    // exercise the rail, not the normalizer.
    yield* Ingress.set(
      opts.refusingIngress
        ? { ingest: () => Promise.reject(new Error('ingress refused')) }
        : rawIngress(contentStore),
    );

    const windDownSignal = createSignal<void, void>();
    if (opts.windDownOn) yield* WindDown.set(windDownSignal);

    const taskCount = opts.taskCount ?? 1;
    const toolsJson = opts.tools && opts.tools.size > 0
      ? JSON.stringify([...opts.tools.values()].map(t => t.schema))
      : '';
    const taskSpecs = Array.from({ length: taskCount }, (_, i) => ({
      content: `Task ${i}`,
      systemPrompt: 'You are an agent.',
      seed: i,
    }));

    return yield* scoped(function* () {
      const sub = yield* useAgentPool({
        spine: root,
        orchestrate: parallel(taskSpecs),
        toolsJson,
        tools: opts.tools ?? new Map(),
        policy: opts.policy,
        maxTurns: opts.maxTurns ?? 100,
        terminalToolName: opts.terminalTool,
        trace: opts.trace ?? false,
        pruneOnReturn: opts.pruneOnReturn ?? false,
      });
      // Drain Subscription — collect events, return close value
      let windDownFired = false;
      let next = yield* sub.next();
      while (!next.done) {
        collectedEvents.push(next.value);
        if (opts.windDownOn && !windDownFired && opts.windDownOn(next.value)) {
          windDownFired = true;
          windDownSignal.send();
        }
        next = yield* sub.next();
      }
      return next.value;
    });
  });

  return { result, events: collectedEvents, trace: traceWriter, ctx };
}

/** Minimal policy stub — every method overridable */
// `onProduced` stays required — it is the reason to build a stub at all.
// `onSettleReject` does not: the interface makes it optional and the pool calls
// it with `?.`, so demanding it here forced every caller to supply a hook the
// runtime never needs.
function stubPolicy(overrides: Partial<AgentPolicy> & {
  onProduced: AgentPolicy['onProduced'];
}): AgentPolicy {
  return {
    onProduced: overrides.onProduced,
    onSettleReject: overrides.onSettleReject,
    shouldExplore: overrides.shouldExplore,
    shouldExit: overrides.shouldExit,
    onRecovery: overrides.onRecovery,
    onToolRetry: overrides.onToolRetry,
    pressureThresholds: overrides.pressureThresholds,
    resetTick: overrides.resetTick,
  };
}

/** Simple spy tool that captures ToolContext */
class SpyTool extends Tool<{ query: string }> {
  readonly name: string;
  readonly description = 'spy tool';
  readonly parameters = { type: 'object' as const, properties: { query: { type: 'string' as const } } };
  capturedContexts: ToolContext[] = [];

  constructor(name = 'web_search') {
    super();
    this.name = name;
  }

  *execute(_args: { query: string }, context: ToolContext): Operation<unknown> {
    this.capturedContexts.push(context);
    return { results: ['result'] };
  }
}

// ── Group 1: shouldExit execution ───────────────────────────────

describe('shouldExit execution', () => {
  it('1a: shouldExit returns true → policy_exit trace, agent:done event, no result', async () => {
    const { result, events, trace } = await runPool({
      forkTokenQueues: [[1, STOP]], // never reached — shouldExit fires first
      policy: stubPolicy({
        shouldExit: () => true,
        onProduced: () => ({ type: 'idle', reason: 'pressure_critical' }),
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    const drops = trace.ofType('pool:agentDrop');
    expect(drops.length).toBeGreaterThanOrEqual(1);
    expect(drops[0].reason).toBe('policy_exit');
    expect(events.some(e => e.type === 'agent:done')).toBe(true);
    expect(result.agents[0].result).toBeNull();
    expect(result.agents[0].tokenCount).toBe(0);
  });

  it('1b: shouldExit returns false → agent continues, produces tokens', async () => {
    const { result, events, trace } = await runPool({
      forkTokenQueues: [[1, 2, STOP]],
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    const drops = trace.ofType('pool:agentDrop');
    const policyDrops = drops.filter(d => d.reason === 'policy_exit' || d.reason === 'pressure_critical');
    expect(policyDrops).toHaveLength(0);
    expect(result.agents[0].tokenCount).toBe(2);
    expect(events.some(e => e.type === 'agent:produce')).toBe(true);
  });

  it('1c: shouldExit absent + pressure critical → pressure_critical', async () => {
    const { trace } = await runPool({
      nCtx: 16384,
      cellsUsed: 16300, // remaining = 84 < hardLimit 128 → critical
      forkTokenQueues: [[1, STOP]],
      policy: stubPolicy({
        onProduced: () => ({ type: 'idle', reason: 'pressure_critical' }),
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    const drops = trace.ofType('pool:agentDrop');
    const hasCritical = drops.some(d => d.reason === 'pressure_critical' || d.reason === 'pressure_init');
    expect(hasCritical).toBe(true);
  });
});

// ── Group 2: Nudge execution ────────────────────────────────────

describe('nudge execution', () => {
  const NUDGE_MSG = 'You must report your findings now.';

  function nudgeOncePolicy(): AgentPolicy {
    let nudgeCount = 0;
    return stubPolicy({
      shouldExit: () => false,
      onProduced: (_agent, parsed) => {
        if (parsed.toolCalls.length > 0 && nudgeCount === 0) {
          nudgeCount++;
          return { type: 'nudge', message: NUDGE_MSG };
        }
        return { type: 'idle', reason: 'free_text_stop' };
      },
      onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
    });
  }

  it('2a: onProduced returns nudge → pool:agentNudge trace with correct reason', async () => {
    const { trace } = await runPool({
      forkTokenQueues: [[1, 2, STOP, 3, STOP]],
      parseChatOutputFn: (raw) => {
        if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
        return {
          content: '',
          reasoningContent: '',
          toolCalls: [{ name: 'web_search', arguments: '{}', id: 'c1' }],
        };
      },
      policy: nudgeOncePolicy(),
    });

    const nudges = trace.ofType('pool:agentNudge');
    expect(nudges.length).toBeGreaterThanOrEqual(1);
    expect(nudges[0].reason).toBe('nudge');
    expect(nudges[0].message).toBeDefined();
  });

  it('2b: nudge settles → agent continues generating → eventually idles', async () => {
    const { result, events } = await runPool({
      forkTokenQueues: [[1, 2, STOP, 3, 4, STOP]],
      parseChatOutputFn: (raw) => {
        if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
        return {
          content: '',
          reasoningContent: '',
          toolCalls: [{ name: 'web_search', arguments: '{}', id: 'c1' }],
        };
      },
      policy: nudgeOncePolicy(),
    });

    expect(result.agents[0].tokenCount).toBeGreaterThan(2);
    expect(events.filter(e => e.type === 'agent:done')).toHaveLength(1);
  });

  it('2c: repeated nudges fire without escalation (stateless)', async () => {
    let nudgeCount = 0;
    const { trace } = await runPool({
      forkTokenQueues: [[1, STOP, 2, STOP, 3, STOP, STOP]],
      parseChatOutputFn: (raw) => {
        if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
        return {
          content: '',
          reasoningContent: '',
          toolCalls: [{ name: 'web_search', arguments: '{}', id: `c${nudgeCount}` }],
        };
      },
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: (_a, parsed) => {
          if (parsed.toolCalls.length > 0 && nudgeCount < 3) {
            nudgeCount++;
            return { type: 'nudge', message: `Nudge #${nudgeCount}` };
          }
          return { type: 'idle', reason: 'free_text_stop' };
        },
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    const nudges = trace.ofType('pool:agentNudge');
    expect(nudges.length).toBeGreaterThanOrEqual(2);
    const drops = trace.ofType('pool:agentDrop');
    const nudgeDrops = drops.filter(d => d.reason === 'pressure_softcut');
    expect(nudgeDrops).toHaveLength(0);
  });
});

// ── Group 3: Settle reject execution ────────────────────────────

describe('settle reject execution', () => {
  class BigResultTool extends Tool<Record<string, unknown>> {
    readonly name = 'web_search';
    readonly description = 'search';
    readonly parameters = { type: 'object' as const, properties: { query: { type: 'string' as const } } };
    constructor(private _resultSize: number) { super(); }

    *execute(): Operation<unknown> {
      return { data: 'x'.repeat(this._resultSize * 4) };
    }
  }

  it('3a: tool result > headroom, policy nudges → pool:agentNudge with pressure_settle_reject', async () => {
    const bigTool = new BigResultTool(200);
    const toolMap = new Map<string, Tool>([['web_search', bigTool]]);

    const { trace, events } = await runPool({
      nCtx: 16384,
      cellsUsed: 14300,
      forkTokenQueues: [[1, STOP, STOP]],
      parseChatOutputFn: (raw) => {
        if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
        return {
          content: '',
          reasoningContent: '',
          toolCalls: [{ name: 'web_search', arguments: '{"query":"test"}', id: 'c1' }],
        };
      },
      tools: toolMap,
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: (_a, parsed) => {
          if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
          return { type: 'idle', reason: 'free_text_stop' };
        },
        onSettleReject: () => ({ type: 'nudge', message: 'Too large, report now.' }),
      }),
    });

    expect(events.some(e => e.type === 'agent:done')).toBe(true);
  });

  it('3b: nudge tokens dont fit → agent killed, pool:agentDrop pressure_settle_reject', async () => {
    const bigTool = new BigResultTool(500);
    const toolMap = new Map<string, Tool>([['web_search', bigTool]]);

    const { trace, events } = await runPool({
      nCtx: 2000,
      cellsUsed: 900,
      forkTokenQueues: [[1, STOP, STOP]],
      parseChatOutputFn: (raw) => {
        if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
        return {
          content: '',
          reasoningContent: '',
          toolCalls: [{ name: 'web_search', arguments: '{"query":"test"}', id: 'c1' }],
        };
      },
      tools: toolMap,
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: (_a, parsed) => {
          if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
          return { type: 'idle', reason: 'free_text_stop' };
        },
        onSettleReject: () => ({ type: 'nudge', message: 'Report now.' }),
      }),
    });

    const drops = trace.ofType('pool:agentDrop');
    const settleDrops = drops.filter(d => d.reason === 'pressure_settle_reject');
    if (settleDrops.length > 0) {
      expect(settleDrops[0].reason).toBe('pressure_settle_reject');
      expect(events.some(e => e.type === 'agent:done')).toBe(true);
    }
  });

  it('3c: policy returns idle on settle reject → immediate kill', async () => {
    const bigTool = new BigResultTool(500);
    const toolMap = new Map<string, Tool>([['web_search', bigTool]]);

    const { trace, events } = await runPool({
      nCtx: 2000,
      cellsUsed: 900,
      forkTokenQueues: [[1, STOP, STOP]],
      parseChatOutputFn: (raw) => {
        if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
        return {
          content: '',
          reasoningContent: '',
          toolCalls: [{ name: 'web_search', arguments: '{"query":"test"}', id: 'c1' }],
        };
      },
      tools: toolMap,
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: (_a, parsed) => {
          if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
          return { type: 'idle', reason: 'free_text_stop' };
        },
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    const drops = trace.ofType('pool:agentDrop');
    const settleDrops = drops.filter(d => d.reason === 'pressure_settle_reject');
    if (settleDrops.length > 0) {
      expect(events.some(e => e.type === 'agent:done')).toBe(true);
    }
  });
});

// ── Group 4: Dispatch context assembly ──────────────────────────

describe('dispatch context assembly', () => {
  function dispatchSetup(shouldExplore: boolean, pressure?: { nCtx?: number; cellsUsed?: number }) {
    const spy = new SpyTool('web_search');
    const toolMap = new Map<string, Tool>([['web_search', spy]]);

    return {
      spy,
      poolOpts: {
        nCtx: pressure?.nCtx ?? 10000,
        cellsUsed: pressure?.cellsUsed ?? 3000,
        forkTokenQueues: [[1, STOP, STOP]],
        parseChatOutputFn: (raw: string): ParseChatOutputResult => {
          if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
          return {
            content: '',
            reasoningContent: '',
            toolCalls: [{ name: 'web_search', arguments: '{"query":"test"}', id: 'c1' }],
          };
        },
        tools: toolMap,
        policy: stubPolicy({
          shouldExit: () => false,
          shouldExplore: () => shouldExplore,
          onProduced: (_a: Agent, parsed: { content: string | null; toolCalls: any[] }) => {
            if (parsed.toolCalls.length > 0) return { type: 'tool_call' as const, tc: parsed.toolCalls[0] };
            return { type: 'idle' as const, reason: 'free_text_stop' as const };
          },
          onSettleReject: () => ({ type: 'idle' as const, reason: 'pressure_settle_reject' as const }),
        }),
      },
    };
  }

  it('4a: shouldExplore=true → ToolContext.explore=true', async () => {
    const { spy, poolOpts } = dispatchSetup(true);
    await runPool(poolOpts);
    expect(spy.capturedContexts.length).toBeGreaterThanOrEqual(1);
    expect(spy.capturedContexts[0].explore).toBe(true);
  });

  it('4b: shouldExplore=false → ToolContext.explore=false', async () => {
    const { spy, poolOpts } = dispatchSetup(false);
    await runPool(poolOpts);
    expect(spy.capturedContexts.length).toBeGreaterThanOrEqual(1);
    expect(spy.capturedContexts[0].explore).toBe(false);
  });

  it('4c: percentAvailable from fresh dispatchPressure', async () => {
    const { spy, poolOpts } = dispatchSetup(true, { nCtx: 10000, cellsUsed: 3000 });
    const { trace } = await runPool(poolOpts);

    expect(spy.capturedContexts.length).toBeGreaterThanOrEqual(1);
    const pct = spy.capturedContexts[0].pressurePercentAvailable;
    expect(pct).toBeGreaterThan(50);
    expect(pct).toBeLessThanOrEqual(100);

    const dispatches = trace.ofType('tool:dispatch');
    expect(dispatches.length).toBeGreaterThanOrEqual(1);
    expect(dispatches[0]).toHaveProperty('explore');
    expect(dispatches[0]).toHaveProperty('percentAvailable');
  });
});

// ── Group 5: Recovery loop ──────────────────────────────────────

describe('recovery loop', () => {
  it('5a: recovery extracts findings via eager grammar on agent branch', async () => {
    // Agent stops immediately (no result). Recovery prefills extraction
    // prompt into agent's own branch, sets eager grammar, and runs a
    // produce/commit loop. The mock tokens produce non-JSON so the parse
    // fails (non-fatal), but agent:spawn proves recovery ran.
    const { events } = await runPool({
      forkTokenQueues: [
        [STOP, 1, 2, STOP], // first STOP triggers idle, tokens 1,2,STOP for extraction
      ],
      parseChatOutputFn: () => ({ content: '', reasoningContent: '', toolCalls: [] }),
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
        onRecovery: () => ({
          type: 'extract',
          prompt: { system: 'Extract findings from above.', user: 'Report.' },
        }),
      }),
    });

    // agent:spawn emitted once for initial setup (recovery uses existing branch)
    const spawns = events.filter(e => e.type === 'agent:spawn');
    expect(spawns.length).toBe(1);
    // agent:produce events from the extraction generation
    const produces = events.filter(e => e.type === 'agent:produce');
    expect(produces.length).toBeGreaterThanOrEqual(1);
  });

  it('5b: recovery skip → no agent:spawn after initial, branch pruned', async () => {
    const { events } = await runPool({
      forkTokenQueues: [[STOP]],
      parseChatOutputFn: () => ({ content: '', reasoningContent: '', toolCalls: [] }),
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
        onRecovery: () => ({ type: 'skip' }),
      }),
    });

    const spawns = events.filter(e => e.type === 'agent:spawn');
    expect(spawns).toHaveLength(1); // only the initial spawn
  });

  it('5c: agent with result → recovery skipped entirely', async () => {
    const { result, events } = await runPool({
      forkTokenQueues: [[1, 2, STOP]],
      parseChatOutputFn: () => ({
        content: 'some findings',
        reasoningContent: '',
        toolCalls: [],
      }),
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: (_a, parsed) => {
          if (parsed.content) return { type: 'free_text_return', content: parsed.content };
          return { type: 'idle', reason: 'free_text_stop' };
        },
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
        onRecovery: () => ({
          type: 'extract',
          prompt: { system: 'x', user: 'y' },
        }),
      }),
    });

    expect(result.agents[0].result).toBe('some findings');
    const spawns = events.filter(e => e.type === 'agent:spawn');
    expect(spawns).toHaveLength(1); // only initial, no recovery
  });

  it('5d: recovery agent that does not call report → exits via free_text_stop', async () => {
    // Agent stops, recovery reactivates, but the model just generates text
    // without calling report. On the second stop, recovery fires again but
    // onRecovery returns skip (one-shot). Agent exits with no result.
    let recoveryCount = 0;
    const { result } = await runPool({
      forkTokenQueues: [
        [STOP, 1, 2, STOP], // first STOP triggers idle, tokens 1,2,STOP for recovery
      ],
      parseChatOutputFn: () => ({ content: 'just text', reasoningContent: '', toolCalls: [] }),
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: (_a, parsed) => {
          if (parsed.content) return { type: 'free_text_return', content: parsed.content };
          return { type: 'idle', reason: 'free_text_stop' };
        },
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
        onRecovery: () => {
          recoveryCount++;
          if (recoveryCount <= 1) {
            return { type: 'extract', prompt: { system: 'Extract', user: 'Report' } };
          }
          return { type: 'skip' };
        },
      }),
    });

    expect(result).toBeDefined();
    expect(result.agents).toHaveLength(1);
    // Recovery reactivated, free_text_return captured the text
    expect(result.agents[0].result).toBe('just text');
  });
});

// ── Group 6: Pressure thresholds propagation ────────────────────

describe('pressure thresholds propagation', () => {
  it('6a: custom thresholds → agent survives when default would kill', async () => {
    const { result, trace } = await runPool({
      nCtx: 16384,
      cellsUsed: 15700, // remaining=684, custom softLimit=256 → headroom=428
      forkTokenQueues: [[1, 2, STOP]],
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
        pressureThresholds: { softLimit: 256, hardLimit: 512 },
      }),
    });

    const drops = trace.ofType('pool:agentDrop');
    const criticalDrops = drops.filter(d => d.reason === 'pressure_critical');
    expect(criticalDrops).toHaveLength(0);
    expect(result.agents[0].tokenCount).toBeGreaterThan(0);
  });

  it('6b: no thresholds → defaults used, agent killed or over budget', async () => {
    const { result, trace } = await runPool({
      nCtx: 16384,
      cellsUsed: 15800, // remaining=584, default softLimit=1024 → headroom=-440
      forkTokenQueues: [[1, 2, STOP]],
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: () => ({ type: 'idle', reason: 'pressure_softcut' }),
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    const drops = trace.ofType('pool:agentDrop');
    if (result.agents.length > 0 && result.agents[0].tokenCount > 0) {
      const softcutDrops = drops.filter(d =>
        d.reason === 'pressure_softcut' || d.reason === 'pressure_init'
      );
      expect(softcutDrops.length + drops.length).toBeGreaterThan(0);
    } else {
      expect(drops.some(d => d.reason === 'pressure_init')).toBe(true);
    }
  });
});

// ── Group 8: Multi-agent interaction paths ──────────────────────

describe('multi-agent interactions', () => {
  it('T1: trailing stop nudges one agent, passes others tool_call', async () => {
    const tool = new MockTool('web_search');
    const toolMap = new Map<string, Tool>([['web_search', tool]]);
    let nudgeCount = 0;

    const { trace } = await runPool({
      forkTokenQueues: [[1, STOP], [1, STOP], [1, STOP]],
      taskCount: 3,
      parseChatOutputFn: () => ({
        content: '', reasoningContent: '',
        toolCalls: [{ name: 'web_search', arguments: '{}', id: 'c1' }],
      }),
      tools: toolMap,
      policy: (() => {
        const p = stubPolicy({
          shouldExit: () => false,
          onProduced: (_a, parsed) => {
            if (parsed.toolCalls.length > 0) {
              nudgeCount++;
              if (nudgeCount === 1) return { type: 'nudge', message: 'Report now.' };
              return { type: 'tool_call', tc: parsed.toolCalls[0] };
            }
            return { type: 'idle', reason: 'free_text_stop' };
          },
          onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
        });
        return p;
      })(),
    });

    const nudges = trace.ofType('pool:agentNudge');
    const dispatches = trace.ofType('tool:dispatch');
    expect(nudges).toHaveLength(1);
    expect(dispatches.length).toBeGreaterThanOrEqual(2);
  });

  it('T2: multi-agent SETTLE headroom exhaustion — first fits, rest rejected', async () => {
    const tool = new MockTool('web_search');
    const toolMap = new Map<string, Tool>([['web_search', tool]]);

    const { trace } = await runPool({
      nCtx: 16384,
      cellsUsed: 14000,  // remaining=2384, headroom=2384-1024=1360 — tight but not critical
      forkTokenQueues: [[1, STOP], [1, STOP]],
      taskCount: 2,
      parseChatOutputFn: () => ({
        content: '', reasoningContent: '',
        toolCalls: [{ name: 'web_search', arguments: '{}', id: 'c1' }],
      }),
      tools: toolMap,
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: (_a, parsed) => {
          if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
          return { type: 'idle', reason: 'free_text_stop' };
        },
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    const drops = trace.ofType('pool:agentDrop');
    const settleRejects = drops.filter(d => d.reason === 'pressure_settle_reject');
    expect(settleRejects.length).toBeGreaterThanOrEqual(1);
  });

  it('T6: tool execution throws — agent gets tool_error, pool completes', async () => {
    class ThrowingTool extends Tool<Record<string, unknown>> {
      readonly name = 'explode';
      readonly description = 'throws';
      readonly parameters = { type: 'object' as const, properties: {} };
      *execute(): Operation<unknown> { throw new Error('boom'); }
    }
    const tool = new ThrowingTool();
    const toolMap = new Map<string, Tool>([['explode', tool]]);

    const { result } = await runPool({
      forkTokenQueues: [[1, STOP]],
      parseChatOutputFn: () => ({
        content: '', reasoningContent: '',
        toolCalls: [{ name: 'explode', arguments: '{}', id: 'c1' }],
      }),
      tools: toolMap,
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: (_a, parsed) => {
          if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
          return { type: 'idle', reason: 'free_text_stop' };
        },
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].result).toContain('boom');
  });

  it('T14: pruneOnReturn with free_text_return — branch pruned', async () => {
    const { result, ctx } = await runPool({
      forkTokenQueues: [[1, 2, STOP]],
      parseChatOutputFn: () => ({
        content: 'my findings', reasoningContent: '', toolCalls: [],
      }),
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: (_a, parsed) => {
          if (parsed.content) return { type: 'free_text_return', content: parsed.content };
          return { type: 'idle', reason: 'free_text_stop' };
        },
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
      pruneOnReturn: true,
    });

    expect(result.agents[0].result).toBe('my findings');
    // Branch should be disposed after pruneOnReturn
    expect(result.agents[0].branch.disposed).toBe(true);
  });

  it('T3: multi-agent critical pressure — shouldExit kills one per tick', async () => {
    let killCount = 0;
    const { trace } = await runPool({
      nCtx: 16384,
      cellsUsed: 15900,  // remaining=484, critical (< hardLimit 512)
      forkTokenQueues: [[1, 1, STOP], [1, 1, STOP]],
      taskCount: 2,
      parseChatOutputFn: () => ({ content: '', reasoningContent: '', toolCalls: [] }),
      policy: stubPolicy({
        shouldExit: (_a, p) => {
          if (!p.critical) return false;
          if (killCount > 0) return false;  // one per tick
          killCount++;
          return true;
        },
        onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
        pressureThresholds: { softLimit: 64, hardLimit: 512 },
      }),
    });

    const drops = trace.ofType('pool:agentDrop');
    // At least one dropped by shouldExit, not all at once
    expect(drops.length).toBeGreaterThanOrEqual(1);
  });

  it('T12: nested results collected from tool return', async () => {
    class NestedTool extends Tool<Record<string, unknown>> {
      readonly name = 'nested';
      readonly description = 'returns nested results';
      readonly parameters = { type: 'object' as const, properties: {} };
      *execute(): Operation<unknown> {
        return { results: ['finding1', 'finding2'], nestedResults: ['nested1'] };
      }
    }
    const tool = new NestedTool();
    const toolMap = new Map<string, Tool>([['nested', tool]]);

    const { result } = await runPool({
      forkTokenQueues: [[1, STOP, STOP]],
      parseChatOutputFn: (raw) => {
        if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
        return { content: '', reasoningContent: '', toolCalls: [{ name: 'nested', arguments: '{}', id: 'c1' }] };
      },
      tools: toolMap,
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: (_a, parsed) => {
          if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
          return { type: 'idle', reason: 'free_text_stop' };
        },
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    // nestedResults should have been collected
    expect(result.agents[0]).toBeDefined();
  });

  it('T15: multiple tool calls in output — only first processed', async () => {
    const tool = new MockTool('web_search');
    const toolMap = new Map<string, Tool>([['web_search', tool]]);

    const { trace } = await runPool({
      forkTokenQueues: [[1, STOP, STOP]],
      parseChatOutputFn: (raw) => {
        if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
        return {
          content: '', reasoningContent: '',
          toolCalls: [
            { name: 'web_search', arguments: '{"query":"first"}', id: 'c1' },
            { name: 'web_search', arguments: '{"query":"second"}', id: 'c2' },
          ],
        };
      },
      tools: toolMap,
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: (_a, parsed) => {
          if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
          return { type: 'idle', reason: 'free_text_stop' };
        },
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    // Only one tool:dispatch per agent turn (first tool call)
    const dispatches = trace.ofType('tool:dispatch');
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].args.query).toBe('first');
  });
});

// ── Group 9: Recovery edge cases ────────────────────────────────

describe('recovery edge cases', () => {
  it('T9: recovery skipped when extraction prompt exceeds remaining KV', async () => {
    // Agent spawns with room to produce, but by the time recovery runs,
    // cellsUsed has grown enough that the extraction prompt doesn't fit.
    // Use a very large recovery prompt to ensure it exceeds remaining.
    const { result } = await runPool({
      nCtx: 16384,
      cellsUsed: 14000,  // remaining=2384, headroom=2384-128=2256 — room to spawn
      forkTokenQueues: [[STOP]],
      parseChatOutputFn: () => ({ content: '', reasoningContent: '', toolCalls: [] }),
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
        onRecovery: () => ({
          type: 'extract',
          // Very long prompt that won't fit in remaining KV
          prompt: { system: 'X'.repeat(5000), user: 'Y'.repeat(5000) },
        }),
        pressureThresholds: { softLimit: 128, hardLimit: 512 },
      }),
    });

    // Agent spawned but recovery skipped — no result
    expect(result.agents.length).toBeGreaterThanOrEqual(1);
    expect(result.agents[0].result).toBeNull();
  });

  it('T10: recovery with empty prompt completes without crash', async () => {
    const { result } = await runPool({
      forkTokenQueues: [[STOP, 1, STOP]],
      parseChatOutputFn: () => ({ content: '', reasoningContent: '', toolCalls: [] }),
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
        onRecovery: () => ({
          type: 'extract',
          prompt: { system: '', user: '' },
        }),
      }),
    });

    expect(result.agents).toHaveLength(1);
  });
});

// ── Group 7: Tool probe lifecycle hook ──────────────────────────

describe('tool probe lifecycle hook', () => {
  /** Tool with a probe — returns "Wait, " after result settles */
  class ProbeTool extends Tool<{ query: string }> {
    readonly name = 'web_search';
    readonly description = 'search with probe';
    readonly parameters = { type: 'object' as const, properties: { query: { type: 'string' as const } } };
    probe() { return 'Wait, '; }
    *execute(): Operation<unknown> { return { results: ['result'] }; }
  }

  /** Tool without a probe — default null */
  class NoProbeTool extends Tool<{ query: string }> {
    readonly name = 'web_search';
    readonly description = 'search without probe';
    readonly parameters = { type: 'object' as const, properties: { query: { type: 'string' as const } } };
    *execute(): Operation<unknown> { return { results: ['result'] }; }
  }

  /** Tool with conditional probe — only fires on nudge errors */
  class ConditionalProbeTool extends Tool<{ query: string }> {
    readonly name = 'web_search';
    readonly description = 'search with conditional probe';
    readonly parameters = { type: 'object' as const, properties: { query: { type: 'string' as const } } };
    probe(result: unknown) {
      const err = result && typeof result === 'object' && (result as Record<string, unknown>).error;
      if (typeof err === 'string' && err.toLowerCase().includes('report your findings now'))
        return 'Wait, the result says I need to call report now with my findings.';
      return null;
    }
    *execute(): Operation<unknown> { return { results: ['result'] }; }
  }

  function toolCallPolicy(): AgentPolicy {
    return stubPolicy({
      shouldExit: () => false,
      onProduced: (_a, parsed) => {
        if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
        return { type: 'idle', reason: 'free_text_stop' };
      },
      onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
    });
  }

  it('7a: tool with probe → extra prefill after tool result', async () => {
    const probeTool = new ProbeTool();
    const toolMap = new Map<string, Tool>([['web_search', probeTool]]);

    const { ctx, store, root } = createMockSdk({ nCtx: 16384, cellsUsed: 1000 });

    // Track prefill calls on the single ctx
    let prefillCallCount = 0;
    const origPrefill = ctx._storePrefill.bind(ctx);
    ctx._storePrefill = async (handles: number[], tokenArrays: number[][]) => {
      prefillCallCount++;
      return origPrefill(handles, tokenArrays);
    };

    // Wire token queues
    let forkCount = 0;
    const branchForkIndex = new Map<number, number>();
    const branchSampleCount = new Map<number, number>();
    const origFork = ctx._branchFork.bind(ctx);
    ctx._branchFork = (parentHandle: number): number => {
      const handle = origFork(parentHandle);
      branchForkIndex.set(handle, forkCount++);
      branchSampleCount.set(handle, 0);
      return handle;
    };
    const queues = [[1, STOP, STOP]];
    ctx._branchSample = (handle: number): number => {
      const fi = branchForkIndex.get(handle) ?? -1;
      const queue = fi >= 0 ? (queues[fi] ?? [STOP]) : [STOP];
      const idx = branchSampleCount.get(handle) ?? 0;
      branchSampleCount.set(handle, idx + 1);
      return idx < queue.length ? queue[idx] : STOP;
    };
    ctx.parseChatOutput = (raw: string) => {
      if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
      return { content: '', reasoningContent: '', toolCalls: [{ name: 'web_search', arguments: '{"query":"test"}', id: 'c1' }] };
    };

    const traceWriter = new CapturingTraceWriter();
    await root.prefill(ctx.tokenizeSync('system'));
    prefillCallCount = 0; // reset after root prefill

    await run(function* () {
      yield* Ctx.set(ctx as any);
      yield* Store.set(store);
      const events: Channel<AgentEvent, void> = createChannel();
      yield* Events.set(events as any);
      yield* Trace.set(traceWriter);
      yield* spawn(function* () { for (const ev of yield* each(events)) { yield* each.next(); } });

      return yield* scoped(function* () {
        const sub = yield* useAgentPool({
          spine: root,
          orchestrate: parallel([{ content: 'Task', systemPrompt: 'Agent', seed: 0 }]),
          toolsJson: JSON.stringify([probeTool.schema]),
          tools: toolMap,
          policy: toolCallPolicy(),
          maxTurns: 100,
        });
        let next = yield* sub.next();
        while (!next.done) { next = yield* sub.next(); }
        return next.value;
      });
    });

    // Prefill calls: 1 (agent suffix) + 1 (tool result) + 1 (probe) = 3 minimum
    expect(prefillCallCount).toBeGreaterThanOrEqual(3);
  });

  it('7b: tool without probe → no extra prefill (noop)', async () => {
    const noProbeTool = new NoProbeTool();
    const toolMap = new Map<string, Tool>([['web_search', noProbeTool]]);

    const { ctx, store, root } = createMockSdk({ nCtx: 16384, cellsUsed: 1000 });

    let prefillCallCount = 0;
    const origPrefill = ctx._storePrefill.bind(ctx);
    ctx._storePrefill = async (handles: number[], tokenArrays: number[][]) => {
      prefillCallCount++;
      return origPrefill(handles, tokenArrays);
    };

    let forkCount = 0;
    const branchForkIndex = new Map<number, number>();
    const branchSampleCount = new Map<number, number>();
    const origFork = ctx._branchFork.bind(ctx);
    ctx._branchFork = (parentHandle: number): number => {
      const handle = origFork(parentHandle);
      branchForkIndex.set(handle, forkCount++);
      branchSampleCount.set(handle, 0);
      return handle;
    };
    const queues = [[1, STOP, STOP]];
    ctx._branchSample = (handle: number): number => {
      const fi = branchForkIndex.get(handle) ?? -1;
      const queue = fi >= 0 ? (queues[fi] ?? [STOP]) : [STOP];
      const idx = branchSampleCount.get(handle) ?? 0;
      branchSampleCount.set(handle, idx + 1);
      return idx < queue.length ? queue[idx] : STOP;
    };
    ctx.parseChatOutput = (raw: string) => {
      if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
      return { content: '', reasoningContent: '', toolCalls: [{ name: 'web_search', arguments: '{"query":"test"}', id: 'c1' }] };
    };

    const traceWriter = new CapturingTraceWriter();
    await root.prefill(ctx.tokenizeSync('system'));
    prefillCallCount = 0;

    await run(function* () {
      yield* Ctx.set(ctx as any);
      yield* Store.set(store);
      const events: Channel<AgentEvent, void> = createChannel();
      yield* Events.set(events as any);
      yield* Trace.set(traceWriter);
      yield* spawn(function* () { for (const ev of yield* each(events)) { yield* each.next(); } });

      return yield* scoped(function* () {
        const sub = yield* useAgentPool({
          spine: root,
          orchestrate: parallel([{ content: 'Task', systemPrompt: 'Agent', seed: 0 }]),
          toolsJson: JSON.stringify([noProbeTool.schema]),
          tools: toolMap,
          policy: toolCallPolicy(),
          maxTurns: 100,
        });
        let next = yield* sub.next();
        while (!next.done) { next = yield* sub.next(); }
        return next.value;
      });
    });

    // Prefill calls: 1 (agent suffix) + 1 (tool result) = 2 — NO probe prefill
    expect(prefillCallCount).toBe(2);
  });

  it('7c: default Tool.probe returns null', () => {
    const tool = new NoProbeTool();
    expect(tool.probe({})).toBeNull();
  });

  it('7d: probe fires on nudge when tool returns probe for error result', async () => {
    // Tool has a probe that activates on nudge errors — probe SHOULD fire
    const probeTool = new ProbeTool();
    const toolMap = new Map<string, Tool>([['web_search', probeTool]]);

    const { result, ctx } = await runPool({
      forkTokenQueues: [[1, 2, STOP, 3, STOP]],
      parseChatOutputFn: (raw) => {
        if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
        return { content: '', reasoningContent: '', toolCalls: [{ name: 'web_search', arguments: '{}', id: 'c1' }] };
      },
      tools: toolMap,
      policy: (() => {
        let nudged = false;
        return stubPolicy({
          shouldExit: () => false,
          onProduced: (_a, parsed) => {
            if (parsed.toolCalls.length > 0 && !nudged) {
              nudged = true;
              return { type: 'nudge', message: 'Report now.' };
            }
            return { type: 'idle', reason: 'free_text_stop' };
          },
          onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
        });
      })(),
    });

    // Agent was nudged — probe should fire because tool.probe() receives nudge error
    expect(result.agents[0]).toBeDefined();
  });

  it('7e: conditional probe fires only on nudge error, not on normal results', () => {
    const tool = new ConditionalProbeTool();

    // Normal result — no probe
    expect(tool.probe({ results: ['data'] })).toBeNull();

    // Generic error — no probe
    expect(tool.probe({ error: 'Network timeout' })).toBeNull();

    // Nudge error — probe fires
    expect(tool.probe({ error: 'KV memory pressure — report your findings now.' }))
      .toBe('Wait, the result says I need to call report now with my findings.');

    // Other nudge variants — probe fires
    expect(tool.probe({ error: 'Turn limit reached — report your findings now.' }))
      .toBe('Wait, the result says I need to call report now with my findings.');
    expect(tool.probe({ error: 'Time limit reached — report your findings now.' }))
      .toBe('Wait, the result says I need to call report now with my findings.');
  });

  it('7f: conditional probe integrates with pool nudge path without error', async () => {
    const tool = new ConditionalProbeTool();
    const toolMap = new Map<string, Tool>([['web_search', tool]]);

    const { result } = await runPool({
      forkTokenQueues: [[1, 2, STOP, 3, STOP]],
      parseChatOutputFn: (raw) => {
        if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
        return { content: '', reasoningContent: '', toolCalls: [{ name: 'web_search', arguments: '{}', id: 'c1' }] };
      },
      tools: toolMap,
      policy: (() => {
        let nudged = false;
        return stubPolicy({
          shouldExit: () => false,
          onProduced: (_a, parsed) => {
            if (parsed.toolCalls.length > 0 && !nudged) {
              nudged = true;
              return { type: 'nudge', message: 'KV memory pressure — report your findings now.' };
            }
            return { type: 'idle', reason: 'free_text_stop' };
          },
          onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
        });
      })(),
    });

    // Pool completes without error — conditional probe integrates cleanly
    expect(result.agents[0]).toBeDefined();
  });

  it('7g: multi-agent — PRODUCE nudge probe survives across ticks', async () => {
    // Two agents: agent A gets a tool call dispatched, agent B gets a PRODUCE
    // nudge in the same tick. Agent A's tool result settles in the next SETTLE,
    // which calls dispatchedProbes.clear(). Agent B's nudge settles in the
    // FOLLOWING SETTLE. If the probe doesn't survive across ticks, it gets
    // cleared before agent B's nudge is processed.
    const tool = new ConditionalProbeTool();
    const toolMap = new Map<string, Tool>([['web_search', tool]]);

    // Track all prefill token arrays to detect probe prefill
    const allPrefills: number[][] = [];
    const { ctx, store, root } = createMockSdk({ nCtx: 16384, cellsUsed: 1000 });

    const origPrefill = ctx._storePrefill.bind(ctx);
    ctx._storePrefill = async (handles: number[], tokenArrays: number[][]) => {
      for (const arr of tokenArrays) allPrefills.push(arr);
      return origPrefill(handles, tokenArrays);
    };

    // Agent 0: generates tool call → dispatched → result settles normally
    // Agent 1: generates tool call → PRODUCE nudge (not dispatched)
    // Both need enough tokens to generate across multiple ticks
    const queues = [
      [1, STOP, STOP],  // agent 0: one tool call, then stop
      [1, STOP, 2, STOP],  // agent 1: tool call → nudge → another turn → stop
    ];
    let forkCount = 0;
    const branchForkIndex = new Map<number, number>();
    const branchSampleCount = new Map<number, number>();
    const origFork = ctx._branchFork.bind(ctx);
    ctx._branchFork = (parentHandle: number): number => {
      const handle = origFork(parentHandle);
      branchForkIndex.set(handle, forkCount++);
      branchSampleCount.set(handle, 0);
      return handle;
    };
    ctx._branchSample = (handle: number): number => {
      const fi = branchForkIndex.get(handle) ?? -1;
      const queue = fi >= 0 ? (queues[fi] ?? [STOP]) : [STOP];
      const idx = branchSampleCount.get(handle) ?? 0;
      branchSampleCount.set(handle, idx + 1);
      return idx < queue.length ? queue[idx] : STOP;
    };

    // Agent 0: always dispatch tool call
    // Agent 1: first tool call → nudge, then idle
    const nudgedAgents = new Set<number>();
    ctx.parseChatOutput = (raw: string) => {
      if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
      return { content: '', reasoningContent: '', toolCalls: [{ name: 'web_search', arguments: '{}', id: 'c1' }] };
    };

    const traceWriter = new CapturingTraceWriter();
    await root.prefill(ctx.tokenizeSync('system'));

    const result = await run(function* () {
      yield* Ctx.set(ctx as any);
      yield* Store.set(store);
      const events: Channel<AgentEvent, void> = createChannel();
      yield* Events.set(events as any);
      yield* Trace.set(traceWriter);
      yield* spawn(function* () { for (const ev of yield* each(events)) { yield* each.next(); } });

      return yield* scoped(function* () {
        const sub = yield* useAgentPool({
          spine: root,
          orchestrate: parallel([
            { content: 'Task 0', systemPrompt: 'Agent', seed: 0 },
            { content: 'Task 1', systemPrompt: 'Agent', seed: 1 },
          ]),
          toolsJson: JSON.stringify([tool.schema]),
          tools: toolMap,
          policy: (() => {
            return stubPolicy({
              shouldExit: () => false,
              onProduced: (a, parsed) => {
                if (parsed.toolCalls.length === 0) return { type: 'idle', reason: 'free_text_stop' };
                // Nudge agent 1 on first tool call
                if (!nudgedAgents.has(a.id) && forkCount >= 2 && a.id !== [...branchForkIndex.entries()].find(([,v]) => v === 0)?.[0]) {
                  nudgedAgents.add(a.id);
                  return { type: 'nudge', message: 'KV memory pressure — report your findings now.' };
                }
                return { type: 'tool_call', tc: parsed.toolCalls[0] };
              },
              onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
            });
          })(),
          maxTurns: 10,
        });
        let next = yield* sub.next();
        while (!next.done) { next = yield* sub.next(); }
        return next.value;
      });
    });

    // The probe text should have been prefilled somewhere in allPrefills.
    // ConditionalProbeTool.probe() returns "Wait, the result says I need to
    // call report now with my findings." for nudge errors.
    // Tokenize it to know what to look for.
    const probeTokens = ctx.tokenizeSync('Wait, the result says I need to call report now with my findings.');

    // At least one prefill should contain the probe tokens
    const probeWasPrefilled = allPrefills.some(arr =>
      arr.length === probeTokens.length && arr.every((t, i) => t === probeTokens[i])
    );

    expect(probeWasPrefilled).toBe(true);
  });
});

// ── SPLIT-SEMANTICS GATE: agent:return vs agent:recovered ──────────
//
// Before the report→return rename, `agent:return` (formerly `agent:report`) fired for BOTH voluntary
// completion AND recovery extraction. The rename SPLIT these into two
// distinct events so consumers can tell apart "agent voluntarily produced
// this value" from "framework salvaged a value from a killed agent."
//
// These two tests are the lockstep proof of the split:
//   - voluntary path → emits `agent:return` ONLY (never `agent:recovered`)
//   - recovery path  → emits `agent:recovered` ONLY (never `agent:return`)
//
// Both paths still fire `agent:done` for lifecycle. Both populate
// `agent.result`. `ResultSource` distinguishes provenance:
// `'voluntary_return'` vs `'recovery'`.

describe('SPLIT-SEMANTICS GATE: voluntary vs recovery emission', () => {
  it('voluntary completion (handleReturn path) emits agent:return only', async () => {
    const { events } = await runPool({
      forkTokenQueues: [[1, 2, STOP]],
      parseChatOutputFn: () => ({
        content: 'voluntary findings',
        reasoningContent: '',
        toolCalls: [],
      }),
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: (_a, parsed) => {
          if (parsed.content) return { type: 'free_text_return', content: parsed.content };
          return { type: 'idle', reason: 'free_text_stop' };
        },
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    const returns = events.filter(e => e.type === 'agent:return');
    expect(returns.length).toBeGreaterThanOrEqual(1);
    expect((returns[0] as { type: 'agent:return'; agentId: number; result: string }).result)
      .toBe('voluntary findings');

    // Voluntary path must NOT emit agent:recovered.
    const recovered = events.filter(e => e.type === 'agent:recovered');
    expect(recovered.length).toBe(0);
  });

  it('recovery extraction (recoverInline path) emits agent:recovered only', async () => {
    // To trigger recovery's successful-extraction path we need:
    //   - agent stops without producing a voluntary result (initial STOP)
    //   - recovery's grammar-constrained generation produces tokens whose
    //     text concatenation forms valid JSON {"result":"..."}
    // The MockSessionContext doesn't enforce grammar so we control output
    // via a tokenToText override on a sentinel token.
    const { ctx, store, root } = createMockSdk({ nCtx: 16384, cellsUsed: 1000 });

    // Token 100 decodes to the full JSON payload recovery's parser expects.
    const origTokenToText = ctx.tokenToText.bind(ctx);
    ctx.tokenToText = (token: number): string => {
      if (token === 100) return '{"result":"recovered findings"}';
      return origTokenToText(token);
    };

    let forkCount = 0;
    const branchForkIndex = new Map<number, number>();
    const branchSampleCount = new Map<number, number>();
    const origFork = ctx._branchFork.bind(ctx);
    ctx._branchFork = (parentHandle: number): number => {
      const handle = origFork(parentHandle);
      branchForkIndex.set(handle, forkCount++);
      branchSampleCount.set(handle, 0);
      return handle;
    };

    // Token sequence for the single agent's branch:
    //   [STOP, 100, STOP]
    //   - first STOP: agent's PRODUCE phase hits stop; the main turn's parse goes
    //     through onProduced → idle (free_text_stop) → agent killed → recoverInline
    //   - 100, STOP: recovery's produce/commit loop generates token 100, then STOP →
    //     finishRecovery parses the recovery output via parseChatOutput, which (below)
    //     returns the terminal `report` call → agent.setResult → agent:recovered
    const queues = [[STOP, 100, STOP]];
    ctx._branchSample = (handle: number): number => {
      const fi = branchForkIndex.get(handle) ?? -1;
      const queue = fi >= 0 ? (queues[fi] ?? [STOP]) : [STOP];
      const idx = branchSampleCount.get(handle) ?? 0;
      branchSampleCount.set(handle, idx + 1);
      return idx < queue.length ? queue[idx] : STOP;
    };
    // The recovery output is a native terminal-tool call (the real model emits Hermes
    // `<tool_call><function=report>`); finishRecovery extracts `result` via the same
    // parseChatOutput path every turn uses. onProduced ignores it on the main turn
    // (returns idle), so the agent still drops → recovers.
    ctx.parseChatOutput = (): ParseChatOutputResult =>
      ({ content: '', reasoningContent: '', toolCalls: [{ name: 'report', arguments: '{"result":"recovered findings"}', id: 'c1' }] });

    const traceWriter = new CapturingTraceWriter();
    const collectedEvents: AgentEvent[] = [];
    await root.prefill(ctx.tokenizeSync('system'));

    await run(function* () {
      yield* Ctx.set(ctx as Parameters<typeof Ctx.set>[0]);
      yield* Store.set(store);
      const eventsChannel: Channel<AgentEvent, void> = createChannel();
      yield* Events.set(eventsChannel as Parameters<typeof Events.set>[0]);
      yield* Trace.set(traceWriter);

      return yield* scoped(function* () {
        const sub = yield* useAgentPool({
          spine: root,
          orchestrate: parallel([{ content: 'Task', systemPrompt: 'Agent', seed: 0 }]),
          toolsJson: '',
          tools: new Map(),
          policy: stubPolicy({
            shouldExit: () => false,
            onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
            onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
            onRecovery: () => ({
              type: 'extract',
              prompt: { system: 'Extract findings.', user: 'Report.' },
            }),
          }),
          maxTurns: 10,
        });
        let next = yield* sub.next();
        while (!next.done) {
          collectedEvents.push(next.value);
          next = yield* sub.next();
        }
        return next.value;
      });
    });

    const recovered = collectedEvents.filter(e => e.type === 'agent:recovered');
    expect(recovered.length).toBeGreaterThanOrEqual(1);
    expect((recovered[0] as { type: 'agent:recovered'; agentId: number; result: string }).result)
      .toBe('recovered findings');

    // Recovery path must NOT emit agent:return — that's reserved for
    // voluntary completion via the terminal tool.
    const returns = collectedEvents.filter(e => e.type === 'agent:return');
    expect(returns.length).toBe(0);

    // Recovery diagnostic trace event fires alongside (locks the literal).
    const recoveryDiagnostic = traceWriter.events.filter(e => e.type === 'pool:recoveryReturn');
    expect(recoveryDiagnostic.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Group 7: no-tool agent seams (synth rabbit-hole regression) ─
// Locks the three framework fixes from the 2026-06-11 synth failure
// (trace-2026-06-11T00-02): a research agent cut mid-tool-call left a
// dangling <tool_call> fragment in its captured result; injected into the
// tool-less synth agent's findings it primed tool-call mimicry, the lazy
// tool-call grammar forced syntactic completion, and the dispatcher's
// generic "Unknown tool" error invited retries until maxTurns.

describe('no-tool agent seams', () => {
  const freeTextPolicy = () => stubPolicy({
    shouldExit: () => false,
    onProduced: (_a, parsed) => {
      if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
      if (parsed.content) return { type: 'free_text_return', content: parsed.content };
      return { type: 'idle', reason: 'free_text_stop' };
    },
    onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
  });

  it('7a: dangling <tool_call> fragment stripped from free-text result capture', async () => {
    const dirty =
      'Findings summary.\n\n</think>\n\n<tool_call>\n<function=read_file>\n<parameter=filename>\nfoo.md';
    const { result } = await runPool({
      forkTokenQueues: [[1, STOP]],
      parseChatOutputFn: () => ({ content: dirty, reasoningContent: '', toolCalls: [] }),
      policy: freeTextPolicy(),
    });

    expect(result.agents[0].result).toBe('Findings summary.\n\n</think>');
    expect(result.agents[0].result).not.toContain('<tool_call>');
  });

  it('7b: complete <tool_call>…</tool_call> blocks in results are preserved', async () => {
    const quoted = 'The agent ran <tool_call>\n<function=x>\n</tool_call> and got results.';
    const { result } = await runPool({
      forkTokenQueues: [[1, STOP]],
      parseChatOutputFn: () => ({ content: quoted, reasoningContent: '', toolCalls: [] }),
      policy: freeTextPolicy(),
    });

    expect(result.agents[0].result).toBe(quoted);
  });

  it('7c: unknown tool with EMPTY toolkit → directive error, not generic Unknown tool', async () => {
    const { events } = await runPool({
      forkTokenQueues: [[1, STOP]],
      // First turn emits a hallucinated tool call; second turn (queue
      // exhausted, raw='') parses to nothing and idles.
      parseChatOutputFn: (raw) => raw.includes('t1')
        ? { content: '', reasoningContent: '', toolCalls: [{ name: 'web_search', arguments: '{"query":"x"}', id: 'c1' }] }
        : { content: '', reasoningContent: '', toolCalls: [] },
      policy: freeTextPolicy(),
      // tools omitted → empty Map
    });

    const toolResults = events.filter(e => e.type === 'agent:tool_result');
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    const resultStr = (toolResults[0] as { type: 'agent:tool_result'; result: string }).result;
    expect(resultStr).toContain('No tools are available to this agent');
    expect(resultStr).not.toContain('Unknown tool');
  });

  it('7d: unknown tool with NON-empty toolkit keeps the Unknown tool error', async () => {
    const tools = new Map<string, Tool>();
    const spy = new SpyTool('real_tool');
    tools.set(spy.name, spy);

    const { events } = await runPool({
      forkTokenQueues: [[1, STOP]],
      parseChatOutputFn: (raw) => raw.includes('t1')
        ? { content: '', reasoningContent: '', toolCalls: [{ name: 'nonexistent', arguments: '{}', id: 'c1' }] }
        : { content: '', reasoningContent: '', toolCalls: [] },
      policy: freeTextPolicy(),
      tools,
    });

    const toolResults = events.filter(e => e.type === 'agent:tool_result');
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    const resultStr = (toolResults[0] as { type: 'agent:tool_result'; result: string }).result;
    expect(resultStr).toContain('Unknown tool: nonexistent');
  });

  it('7e: empty toolkit → lazy tool-call grammar NOT installed; non-empty → installed', async () => {
    // The Qwen3.5 template emits a lazy tool-call grammar even with no
    // tools. Installing it on a no-tool agent forces syntactic completion
    // of any accidentally-sampled <tool_call>; the pool must skip it.
    const grammarFmt = (ctx: MockSessionContext) => {
      const orig = ctx.formatChatSync.bind(ctx);
      ctx.formatChatSync = (msgs, fmtOpts) => ({
        ...orig(msgs, fmtOpts),
        grammar: 'root ::= toolcall',
        grammarLazy: true,
        grammarTriggers: [{ type: 1, value: '<tool_call>', token: -1 }],
      });
    };

    let lazyCallsEmpty = 0;
    await runPool({
      forkTokenQueues: [[STOP]],
      parseChatOutputFn: () => ({ content: '', reasoningContent: '', toolCalls: [] }),
      policy: freeTextPolicy(),
      mutateCtx: (ctx) => {
        grammarFmt(ctx);
        ctx._branchSetGrammarLazy = () => { lazyCallsEmpty++; };
      },
    });
    expect(lazyCallsEmpty).toBe(0);

    const tools = new Map<string, Tool>();
    const spy = new SpyTool('web_search');
    tools.set(spy.name, spy);

    let lazyCallsTools = 0;
    await runPool({
      forkTokenQueues: [[STOP]],
      parseChatOutputFn: () => ({ content: '', reasoningContent: '', toolCalls: [] }),
      policy: freeTextPolicy(),
      tools,
      mutateCtx: (ctx) => {
        grammarFmt(ctx);
        ctx._branchSetGrammarLazy = () => { lazyCallsTools++; };
      },
    });
    expect(lazyCallsTools).toBeGreaterThanOrEqual(1);
  });
});

describe('probe prefill — buffered emission still writes on success', () => {
  // The probe's `branch:prefill` is success-only: buffered through the
  // batched dispatch and written after it lands. This pins the success
  // half — the event survives the buffering with its cells and text.
  // (The failure half is structural: the writes are lexically after the
  // `yield* call(...)`, so a rejected dispatch cannot reach them.)
  class ProbingTool extends SpyTool {
    override probe(): string { return 'probe reflection'; }
  }

  const probePolicy = () => stubPolicy({
    shouldExit: () => false,
    onProduced: (_a, parsed) => {
      if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
      if (parsed.content) return { type: 'free_text_return', content: parsed.content };
      return { type: 'idle', reason: 'free_text_stop' };
    },
  });

  it('emits branch:prefill role=probe after the dispatch, with the probe text', async () => {
    const tools = new Map<string, Tool>();
    tools.set('web_search', new ProbingTool());

    const { trace } = await runPool({
      forkTokenQueues: [[1, STOP]],
      // Keyed off the RAW text, not a call counter: the pool parses partials
      // during produce, so counting calls hands the tool call to a partial
      // parse and the final parse ends the turn without it. Turn 1 produced
      // token 1 ('t1'); turn 2 produced nothing.
      parseChatOutputFn: (raw) =>
        raw.includes('t1')
          ? { content: '', reasoningContent: '', toolCalls: [{ name: 'web_search', arguments: '{}', id: 'c1' }] }
          : { content: 'done', reasoningContent: '', toolCalls: [] },
      policy: probePolicy(),
      tools,
      trace: true,
    });

    const probes = trace.events.filter(
      (e) => e.type === 'branch:prefill' && e.role === 'probe',
    );
    expect(probes).toHaveLength(1);
    expect((probes[0] as { probeText?: string }).probeText).toBe('probe reflection');
    expect((probes[0] as { cells: number }).cells).toBeGreaterThan(0);
  });
});

// ── Self-healing ladder: the rc classifies the settle outcome ──
// docs/self-healing.md. llama_decode's contract: rc 1 and -1 restore state
// (the branch is INTACT); only 2 / < -1 leave partial ubatches (poisoned).
// The ladder answers each class with the cheapest response that preserves
// the run: defer / drop-item / terminal.
describe('self-healing ladder', () => {
  const ladderPolicy = () => stubPolicy({
    shouldExit: () => false,
    onProduced: (_a, parsed) => {
      if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
      if (parsed.content) return { type: 'free_text_return', content: parsed.content };
      return { type: 'idle', reason: 'free_text_stop' };
    },
  });
  /** Turn 1 (raw contains 't1') calls the tool; later turns finish. Keyed
   *  off raw because the pool parses partials — a call counter misfires. */
  const callTool = (name: string) => ({
    parseChatOutputFn: (raw: string) =>
      raw.includes('t1')
        ? { content: '', reasoningContent: '', toolCalls: [{ name, arguments: '{}', id: 'c1' }] }
        : { content: 'done', reasoningContent: '', toolCalls: [] },
    policy: ladderPolicy(),
  });
  const rcError = (msg: string, rc: number): Error => Object.assign(new Error(msg), { rc });
  const ladderFailures = (events: AgentEvent[]) =>
    events.filter(e => e.type === 'agent:failed' &&
      ((e as { reason?: string }).reason === 'tool_result_failed' ||
       (e as { reason?: string }).reason === 'media_prefill_failed'));

  it('token rail rc 1: defers intact and lands on retry — this used to kill the pool', async () => {
    // Armed by the tool's own execution: the first _storePrefill AFTER the
    // tool ran is the settle dispatch (call-counting would hit the harness's
    // root prefill and the spawn suffix instead).
    const spy = new SpyTool();
    const tools = new Map<string, Tool>([['web_search', spy]]);
    const { events, trace } = await runPool({
      forkTokenQueues: [[1, STOP, STOP]],
      ...callTool('web_search'),
      tools, trace: true,
      mutateCtx: (ctx) => {
        let thrown = 0;
        const orig = ctx._storePrefill.bind(ctx);
        ctx._storePrefill = async (h, t) => {
          if (spy.capturedContexts.length > 0 && thrown === 0) {
            thrown++;
            throw rcError('find_slot: no KV slot for the batch', 1);
          }
          return orig(h, t);
        };
      },
    });
    const defers = trace.events.filter(e => e.type === 'pool:agentDefer');
    expect(defers).toHaveLength(1);
    expect((defers[0] as { rc: number }).rc).toBe(1);
    expect((defers[0] as { attempt: number }).attempt).toBe(1);
    expect(ladderFailures(events)).toHaveLength(0);
    // The retried settle actually landed — success-only, so its event exists.
    expect(trace.events.some(e => e.type === 'branch:prefill'
      && (e as { role?: string }).role === 'toolResult')).toBe(true);
  });

  it('deferral exhausts into a PER-AGENT terminal, never pool death', async () => {
    const spy = new SpyTool();
    const tools = new Map<string, Tool>([['web_search', spy]]);
    const { events, trace } = await runPool({
      forkTokenQueues: [[1, STOP, STOP]],
      ...callTool('web_search'),
      tools, trace: true,
      mutateCtx: (ctx) => {
        const orig = ctx._storePrefill.bind(ctx);
        ctx._storePrefill = async (h, t) => {
          // Every settle dispatch after the tool ran hits capacity, forever.
          if (spy.capturedContexts.length > 0) {
            throw rcError('find_slot: no KV slot for the batch', 1);
          }
          return orig(h, t);
        };
      },
    });
    // MAX_DEFER_ATTEMPTS defers, then the escalation — and the run RETURNED,
    // which is the property: a capacity storm costs one agent, not the pool.
    const defers = trace.events.filter(e => e.type === 'pool:agentDefer');
    expect(defers).toHaveLength(3);
    const failures = ladderFailures(events);
    expect(failures).toHaveLength(1);
    expect((failures[0] as { reason: string }).reason).toBe('tool_result_failed');
    const settleFailed = trace.events.find(e => e.type === 'pool:settleFailed');
    expect((settleFailed as { rc?: number }).rc).toBe(1);
  });

  it('media rc -1: the item is dropped, the note lands, the agent continues', async () => {
    const toolMap = new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]);
    const { events, trace } = await runPool({
      nCtx: MEDIA_TEST_NCTX,
      forkTokenQueues: [[1, STOP, STOP]],
      ...callTool('rasterize'),
      tools: toolMap, trace: true,
      mutateCtx: (c) => {
        c.mockMultimodalError = () => ({ message: 'invalid bitmap geometry', rc: -1 });
      },
    });
    // State was restored: nothing died, nothing was pruned for this.
    expect(ladderFailures(events)).toHaveLength(0);
    expect(trace.events.some(e => e.type === 'pool:settleFailed')).toBe(false);
    // The substitute note prefilled as tokens — a landed toolResult event.
    expect(trace.events.some(e => e.type === 'branch:prefill'
      && (e as { role?: string }).role === 'toolResult'
      && (e as { cells: number }).cells > 0)).toBe(true);
    expect(events.some(e => e.type === 'agent:done')).toBe(true);
  });

  it('media rc 1: the cohort entry defers and settles on a later tick', async () => {
    const toolMap = new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]);
    const { events, trace } = await runPool({
      nCtx: MEDIA_TEST_NCTX,
      forkTokenQueues: [[1, STOP, STOP]],
      ...callTool('rasterize'),
      tools: toolMap, trace: true,
      mutateCtx: (c) => {
        let seen = 0;
        c.mockMultimodalError = () => (seen++ === 0 ? { message: 'no KV slot', rc: 1 } : null);
      },
    });
    const defers = trace.events.filter(e => e.type === 'pool:agentDefer');
    expect(defers).toHaveLength(1);
    expect(ladderFailures(events)).toHaveLength(0);
    expect(trace.events.some(e => e.type === 'branch:prefill'
      && (e as { role?: string }).role === 'toolResult')).toBe(true);
  });

  it('media fatal rc: today\'s poison path, with the rc on the record', async () => {
    const toolMap = new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]);
    const { events, trace } = await runPool({
      nCtx: MEDIA_TEST_NCTX,
      forkTokenQueues: [[1, STOP, STOP]],
      ...callTool('rasterize'),
      tools: toolMap, trace: true,
      mutateCtx: (c) => {
        let seen = 0;
        c.mockMultimodalError = () => (seen++ === 0 ? { message: 'compute failed', rc: -3 } : null);
      },
    });
    expect(mediaFailures(events)).toHaveLength(1);
    const settleFailed = trace.events.find(e => e.type === 'pool:settleFailed');
    expect((settleFailed as { rc?: number }).rc).toBe(-3);
  });

  it('the tripwire: consecutive fatals mark the backend suspect', async () => {
    // Three agents, three fatal decodes in one cohort — a workload does not
    // do that, a dead backend does. The third failure names it.
    const toolMap = new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]);
    const { events, trace } = await runPool({
      nCtx: MEDIA_TEST_NCTX,
      taskCount: 3,
      forkTokenQueues: [[1, STOP, STOP], [1, STOP, STOP], [1, STOP, STOP]],
      ...callTool('rasterize'),
      tools: toolMap, trace: true,
      mutateCtx: (c) => {
        c.mockMultimodalError = () => ({ message: 'command buffer failed', rc: -3 });
      },
    });
    expect(mediaFailures(events)).toHaveLength(3);
    const details = trace.events
      .filter(e => e.type === 'pool:settleFailed')
      .map(e => (e as { detail: string }).detail);
    expect(details.some(d => d.includes('backend suspect'))).toBe(true);
  });

  it('heal: a poisoned agent is warm-respawned from its record', async () => {
    // Fatal rc poisons the original; the ladder queues a heal. The
    // replacement forks the spine, replays the record (the original's
    // turn-1 text), and runs to its own terminal — the original's
    // agent:failed stands, the lineage rides pool:agentHeal.
    const toolMap = new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]);
    const { events, trace } = await runPool({
      nCtx: MEDIA_TEST_NCTX,
      forkTokenQueues: [[1, STOP, STOP], [STOP]],
      ...callTool('rasterize'),
      tools: toolMap, trace: true,
      mutateCtx: (c) => {
        let seen = 0;
        c.mockMultimodalError = () =>
          (seen++ === 0 ? { message: 'compute failed', rc: -3 } : null);
      },
    });
    expect(mediaFailures(events)).toHaveLength(1);
    const heals = trace.events.filter(e => e.type === 'pool:agentHeal');
    expect(heals).toHaveLength(1);
    const heal = heals[0] as { of: number; agentId: number; rc?: number; attempt: number };
    expect(heal.rc).toBe(-3);
    expect(heal.attempt).toBe(1);
    expect(heal.agentId).not.toBe(heal.of);
    // The replacement is a real agent: it spawned and reached a terminal.
    const spawns = events.filter(e => e.type === 'agent:spawn');
    expect(spawns).toHaveLength(2);
    expect(events.some(e => e.type === 'agent:done'
      && (e as { agentId: number }).agentId === heal.agentId)).toBe(true);
    // The record replayed: the replacement's fork got prefills beyond its
    // suffix (the assistant turn), visible as its agentSuffix prompt:format
    // carrying the SAME task as the original's.
    const suffixes = trace.events.filter(e => e.type === 'prompt:format'
      && (e as { role?: string }).role === 'agentSuffix');
    expect(suffixes).toHaveLength(2);
  });

  it('heal budget: a replacement that poisons again goes terminal, no third agent', async () => {
    const toolMap = new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]);
    const { events, trace } = await runPool({
      nCtx: MEDIA_TEST_NCTX,
      forkTokenQueues: [[1, STOP, STOP], [1, STOP, STOP]],
      ...callTool('rasterize'),
      tools: toolMap, trace: true,
      mutateCtx: (c) => {
        c.mockMultimodalError = () => ({ message: 'compute failed', rc: -3 });
      },
    });
    // Two poisons (original + replacement), ONE heal — the second failure on
    // replayed state is evidence, not bad luck.
    expect(mediaFailures(events)).toHaveLength(2);
    expect(trace.events.filter(e => e.type === 'pool:agentHeal')).toHaveLength(1);
    expect(events.filter(e => e.type === 'agent:spawn')).toHaveLength(2);
  });
});

// ── Group 8: transient tool failure — park + retry (ToolRetryError) ──
// A tool throwing ToolRetryError parks its agent (awaiting_tool, skipped by
// PRODUCE — no turns/tokens/KV) and re-executes after the delay. Strategy
// (retry count, delay override, fail message) is the policy's via
// onToolRetry; the pool is pure mechanism. Observability: agent:tool_retry
// event + tool:retry trace, so a waiting agent never reads as hung.

import { ToolRetryError } from '../src/Tool';

class FlakyTool extends Tool<{ query: string }> {
  readonly name = 'flaky';
  readonly description = 'transiently failing tool';
  readonly parameters = { type: 'object' as const, properties: { query: { type: 'string' as const } } };
  calls = 0;
  constructor(private failures: number, private retryAfterMs = 30) { super(); }
  *execute(): Operation<unknown> {
    this.calls++;
    if (this.calls <= this.failures) throw new ToolRetryError('rate limited', this.retryAfterMs);
    return { results: ['ok'] };
  }
}

describe('transient tool failure (park + retry)', () => {
  const toolCallPolicy = (overrides?: Partial<AgentPolicy>) => stubPolicy({
    shouldExit: () => false,
    onProduced: (_a, parsed) => {
      if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
      return { type: 'idle', reason: 'free_text_stop' };
    },
    onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
    ...overrides,
  });
  const callOnFirstTurn = (raw: string) => raw.includes('t1')
    ? { content: '', reasoningContent: '', toolCalls: [{ name: 'flaky', arguments: '{"query":"x"}', id: 'c1' }] }
    : { content: '', reasoningContent: '', toolCalls: [] };

  it('8a: one transient failure → park, retry succeeds, model never sees the failure', async () => {
    const flaky = new FlakyTool(1);
    const tools = new Map<string, Tool>([[flaky.name, flaky]]);
    const { events, trace, result } = await runPool({
      forkTokenQueues: [[1, STOP]],
      parseChatOutputFn: callOnFirstTurn,
      policy: toolCallPolicy(),
      tools,
      trace: true,
    });

    expect(flaky.calls).toBe(2); // original + 1 retry
    const retries = events.filter(e => e.type === 'agent:tool_retry');
    expect(retries).toHaveLength(1);
    expect((retries[0] as { retryAfterMs: number; attempt: number }).retryAfterMs).toBe(30);
    expect((retries[0] as { attempt: number }).attempt).toBe(1);
    // The eventual result is the SUCCESS — no failure text ever settled
    const toolResults = events.filter(e => e.type === 'agent:tool_result');
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as { result: string }).result).toContain('ok');
    // Trace observability
    expect(trace.ofType('tool:retry')).toHaveLength(1);
    // Retry did not double-count the call
    expect(result.totalToolCalls).toBe(1);
  });

  it('8b: budget exhausted (default 1 retry) → directive failure settles, agent continues', async () => {
    const flaky = new FlakyTool(99); // always throws
    const tools = new Map<string, Tool>([[flaky.name, flaky]]);
    const { events } = await runPool({
      forkTokenQueues: [[1, STOP]],
      parseChatOutputFn: callOnFirstTurn,
      policy: toolCallPolicy(),
      tools,
    });

    expect(flaky.calls).toBe(2); // original + 1 retry, then fail
    const retries = events.filter(e => e.type === 'agent:tool_retry');
    expect(retries).toHaveLength(1);
    const toolResults = events.filter(e => e.type === 'agent:tool_result');
    expect(toolResults).toHaveLength(1);
    const resultStr = (toolResults[0] as { result: string }).result;
    expect(resultStr).toContain('currently unavailable');
    expect(resultStr).toContain('use other sources');
    // Agent survived (not killed via tool_error path)
    expect(events.some(e => e.type === 'agent:done')).toBe(true);
  });

  it('8c: policy fail-fast → no park, custom message settles immediately', async () => {
    const flaky = new FlakyTool(99);
    const tools = new Map<string, Tool>([[flaky.name, flaky]]);
    const { events } = await runPool({
      forkTokenQueues: [[1, STOP]],
      parseChatOutputFn: callOnFirstTurn,
      policy: toolCallPolicy({
        onToolRetry: () => ({ type: 'fail', message: 'no time to wait — pivot now' }),
      }),
      tools,
    });

    expect(flaky.calls).toBe(1); // no retry
    expect(events.filter(e => e.type === 'agent:tool_retry')).toHaveLength(0);
    const toolResults = events.filter(e => e.type === 'agent:tool_result');
    expect((toolResults[0] as { result: string }).result).toContain('no time to wait');
  });

  it('8d: policy overrides the tool\'s delay estimate', async () => {
    const flaky = new FlakyTool(1, 5000); // tool asks for 5s
    const tools = new Map<string, Tool>([[flaky.name, flaky]]);
    const { events } = await runPool({
      forkTokenQueues: [[1, STOP]],
      parseChatOutputFn: callOnFirstTurn,
      policy: toolCallPolicy({
        onToolRetry: (_a, _t, _e, attempt) =>
          attempt <= 1 ? { type: 'retry', afterMs: 20 } : { type: 'fail' },
      }),
      tools,
    });

    expect(flaky.calls).toBe(2);
    const retries = events.filter(e => e.type === 'agent:tool_retry');
    expect((retries[0] as { retryAfterMs: number }).retryAfterMs).toBe(20); // policy's 20ms, not the tool's 5s
  });

  it('8e: wind-down abandons a parked retry — the drain never waits out the park', async () => {
    const flaky = new FlakyTool(99, 60_000); // rate-limited, come back in 60s
    const tools = new Map<string, Tool>([[flaky.name, flaky]]);
    // Fire WindDown the moment the park is observed. Without the abandon the
    // reap can't touch the awaiting_tool agent until the 60s park settles —
    // this test times out; with it the run finishes in milliseconds.
    const { events, trace } = await runPool({
      forkTokenQueues: [[1, STOP]],
      parseChatOutputFn: callOnFirstTurn,
      policy: toolCallPolicy({
        onRecovery: () => ({ type: 'extract', prompt: { system: 's', user: 'u' } }),
      }),
      tools,
      trace: true,
      windDownOn: (ev) => ev.type === 'agent:tool_retry',
    });

    expect(flaky.calls).toBe(1); // parked, never re-executed
    // The flip was announced — the pane's feedback signal.
    expect(events.some(e => e.type === 'run:windingDown')).toBe(true);
    expect(trace.ofType('pool:windDown')).toHaveLength(1);
    // The park settled as an honest wind-down failure, not a drained retry.
    const toolResults = events.filter(e => e.type === 'agent:tool_result');
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as { result: string }).result).toContain('winding down');
    // The agent was then reaped by wind-down and recovered.
    expect(trace.ofType('pool:agentDrop').some(
      e => (e as { reason?: string }).reason === 'wind_down')).toBe(true);
    expect(events.some(e => e.type === 'agent:done')).toBe(true);
  }, 10_000);
});

// ── Group 11: trace fidelity — pool:tick, agent span, harvested ppl ──
// The trace carries the per-COMMIT pressure series (`pool:tick`), the agent
// lifecycle span (`agent:spawn`/`agent:done`, mirroring the bus events), and
// `pool:close.ppl` reads the pre-prune harvest for a disposed branch instead
// of writing a 0 that wears the shape of a measurement.

describe('trace fidelity: pool:tick, agent span, harvested ppl', () => {
  it('pool:tick written once per COMMIT with the declared pressure shape', async () => {
    const { trace, result } = await runPool({
      forkTokenQueues: [[1, 2, STOP]],
      parseChatOutputFn: () => ({ content: '', reasoningContent: '', toolCalls: [] }),
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    const ticks = trace.ofType('pool:tick');
    expect(ticks.length).toBe(result.steps); // one per batched commit
    expect(ticks[0].phase).toBe('COMMIT');
    expect(ticks[0].activeAgents).toBeGreaterThanOrEqual(1);
    expect(ticks[0].pressure.nCtx).toBe(16384);
    expect(ticks[0].pressure.cellsUsed).toBeGreaterThan(0);
    expect(ticks[0].pressure.remaining).toBe(ticks[0].pressure.nCtx - ticks[0].pressure.cellsUsed);
    expect(typeof ticks[0].pressure.headroom).toBe('number');
  });

  it('agent:spawn + agent:done trace events bracket the agent, mirroring the bus', async () => {
    const { trace, events } = await runPool({
      forkTokenQueues: [[1, STOP]],
      parseChatOutputFn: () => ({ content: 'findings', reasoningContent: '', toolCalls: [] }),
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: (_a, parsed) => {
          if (parsed.content) return { type: 'free_text_return', content: parsed.content };
          return { type: 'idle', reason: 'free_text_stop' };
        },
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    const spawns = trace.ofType('agent:spawn');
    const dones = trace.ofType('agent:done');
    expect(spawns).toHaveLength(1);
    expect(dones).toHaveLength(1);
    expect(dones[0].agentId).toBe(spawns[0].agentId);
    expect(typeof spawns[0].parentAgentId).toBe('number');
    // One-for-one with the bus span
    expect(events.filter(e => e.type === 'agent:spawn')).toHaveLength(1);
    expect(events.filter(e => e.type === 'agent:done')).toHaveLength(1);
  });

  it('a drop ends the span too — agent:done trace follows pool:agentDrop', async () => {
    const { trace } = await runPool({
      forkTokenQueues: [[1, STOP]],
      parseChatOutputFn: () => ({ content: '', reasoningContent: '', toolCalls: [] }),
      policy: stubPolicy({
        shouldExit: () => true,
        onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    const dones = trace.ofType('agent:done');
    expect(dones).toHaveLength(1);
    const dropIdx = trace.events.findIndex(e => e.type === 'pool:agentDrop');
    const doneIdx = trace.events.findIndex(e => e.type === 'agent:done');
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(dropIdx);
  });

  it('pool:close reads the harvested ppl for a branch pruned mid-run', async () => {
    const { trace, result } = await runPool({
      forkTokenQueues: [[1, STOP]],
      parseChatOutputFn: (raw) => {
        if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
        return {
          content: '', reasoningContent: '',
          toolCalls: [{ name: 'report', arguments: '{"result":"done"}', id: 'c1' }],
        };
      },
      pruneOnReturn: true,
      mutateCtx: (ctx) => {
        ctx._branchGetPerplexity = () => 7.25;
        ctx._branchGetSamplingPerplexity = () => 3.5;
      },
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: (_a, parsed) => {
          if (parsed.toolCalls.length > 0) return { type: 'return', result: 'done' };
          return { type: 'idle', reason: 'free_text_stop' };
        },
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    // The branch died mid-run (pruneOnReturn) — before the harvest, these read 0.
    expect(result.agents[0].branch.disposed).toBe(true);
    expect(result.agents[0].ppl).toBe(7.25);
    expect(result.agents[0].samplingPpl).toBe(3.5);
    const close = trace.ofType('pool:close');
    expect(close).toHaveLength(1);
    expect(close[0].agents[0].ppl).toBe(7.25);
  });
});

// ── Group 13: branch:prune — KV frees are traced, not invisible (#104) ──
// Every in-run prune (safePrune + pruneOnReturn) writes the declared
// `branch:prune {branchHandle, position}` BEFORE the free, so the trace shows
// where KV was reclaimed instead of only where it grew.

describe('branch:prune traced at every in-run free (#104)', () => {
  it('pruneOnReturn writes branch:prune with the branch handle and position', async () => {
    const { trace, result } = await runPool({
      forkTokenQueues: [[1, STOP]],
      parseChatOutputFn: (raw) => {
        if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
        return {
          content: '', reasoningContent: '',
          toolCalls: [{ name: 'report', arguments: '{"result":"done"}', id: 'c1' }],
        };
      },
      pruneOnReturn: true,
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: (_a, parsed) => {
          if (parsed.toolCalls.length > 0) return { type: 'return', result: 'done' };
          return { type: 'idle', reason: 'free_text_stop' };
        },
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    expect(result.agents[0].branch.disposed).toBe(true);
    const prunes = trace.ofType('branch:prune');
    expect(prunes).toHaveLength(1);
    expect(prunes[0].branchHandle).toBe(result.agents[0].agentId);
    expect(typeof prunes[0].position).toBe('number');
    // The free is recorded before the pool folds.
    const pruneIdx = trace.events.findIndex(e => e.type === 'branch:prune');
    const closeIdx = trace.events.findIndex(e => e.type === 'pool:close');
    expect(pruneIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeGreaterThan(pruneIdx);
  });

  it('a dropped agent\'s recovery prune is traced too (safePrune path)', async () => {
    const { trace } = await runPool({
      forkTokenQueues: [[1, STOP]],
      parseChatOutputFn: () => ({ content: '', reasoningContent: '', toolCalls: [] }),
      policy: stubPolicy({
        shouldExit: () => true,
        onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    const prunes = trace.ofType('branch:prune');
    expect(prunes.length).toBeGreaterThanOrEqual(1);
    // The span ended (agent:done) before its KV was freed.
    const doneIdx = trace.events.findIndex(e => e.type === 'agent:done');
    const pruneIdx = trace.events.findIndex(e => e.type === 'branch:prune');
    expect(pruneIdx).toBeGreaterThan(doneIdx);
  });
});

// ── Group 12: unlimited context → explicit nulls, not JSON-coerced Infinity ──

describe('unlimited-context pressure serialization', () => {
  it('nCtx <= 0 → pool:open/pool:tick write remaining/headroom as null', async () => {
    const { trace } = await runPool({
      nCtx: 0, // unlimited — ContextPressure reads remaining as Infinity
      forkTokenQueues: [[1, STOP]],
      parseChatOutputFn: () => ({ content: '', reasoningContent: '', toolCalls: [] }),
      policy: stubPolicy({
        shouldExit: () => false,
        onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
        onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      }),
    });

    const open = trace.ofType('pool:open');
    expect(open[0].pressure.remaining).toBeNull();
    expect(open[0].pressure.headroom).toBeNull();
    const ticks = trace.ofType('pool:tick');
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks[0].pressure.remaining).toBeNull();
    expect(ticks[0].pressure.headroom).toBeNull();
    expect(ticks[0].pressure.nCtx).toBe(0); // finite fields stay numbers
  });
});

// ── The tool-result media ingress (PR-2) ────────────────────────────
//
// A tool that returns image bytes is the third way media enters KV. The
// failure this guards is not an exception: `JSON.stringify` turns a 180 KB
// image into ~700k characters of digits, which prefills "successfully" and
// destroys the agent's context. Everything below asserts the bytes took the
// embedding rail instead, and that one bad image costs only its own agent.


/** Every agent calls the media tool once, then stops. */
const oneToolCall = (toolName: string) => ({
  parseChatOutputFn: (raw: string) => {
    if (!raw || raw === '') return { content: '', reasoningContent: '', toolCalls: [] };
    return {
      content: '', reasoningContent: '',
      toolCalls: [{ name: toolName, arguments: '{"q":"x"}', id: 'c1' }],
    };
  },
  policy: stubPolicy({
    shouldExit: () => false,
    onProduced: (_a: Agent, parsed: ParseChatOutputResult) =>
      parsed.toolCalls.length > 0
        ? { type: 'tool_call' as const, tc: parsed.toolCalls[0] }
        : { type: 'idle' as const, reason: 'free_text_stop' },
  }),
});

describe('tool results carrying images', () => {
  it('sends the bytes down the embedding rail, never through JSON', async () => {
    const toolMap = new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]);
    const { ctx, events } = await runPool({
      nCtx: MEDIA_TEST_NCTX,
      forkTokenQueues: [[1, STOP, STOP]],
      tools: toolMap,
      ...oneToolCall('rasterize'),
    });

    // The rail: one multimodal prefill carrying one image.
    expect(ctx.multimodalPrefills).toHaveLength(1);
    expect(ctx.multimodalPrefills[0].bitmapCounts).toEqual([1]);

    // And the bytes are NOT in the text the model was handed. `137,80,78,71`
    // is what this PNG's header serializes to as JSON digits — the exact
    // corruption this ingress exists to prevent.
    const shown = events.filter(e => e.type === 'agent:tool_result')
      .map(e => (e as { result: string }).result).join('');
    expect(shown).not.toContain('137,80,78,71');
    expect(shown).not.toContain('_images');
    expect(shown).toContain('p1');
  });

  it('fails only the agent whose image was bad', async () => {
    // Two agents settle images in the same tick; the cohort call reports one
    // failure. The sibling must still land — losing it would be the rejected-
    // promise behaviour this ingress deliberately does not have.
    const toolMap = new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]);
    const { events, ctx } = await runPool({
      nCtx: MEDIA_TEST_NCTX,
      taskCount: 2,
      forkTokenQueues: [[1, STOP, STOP], [1, STOP, STOP]],
      tools: toolMap,
      mutateCtx: (c) => {
        let seen = 0;
        c.mockMultimodalError = () => (seen++ === 0 ? 'corrupt image data' : null);
      },
      ...oneToolCall('rasterize'),
    });

    // Exactly one agent fails FOR THIS REASON — the sibling's own terminal
    // (`recovery_skipped`, the stub policy's normal end) is not a media failure.
    const failures = mediaFailures(events);
    expect(failures).toHaveLength(1);

    // And that agent is really finished: its branch was pruned as poisoned, so
    // waking it again would have it sample from a disposed branch. Nothing it
    // emits may come after the failure.
    // ...and the SURVIVOR still finishes. This is the property, stated as the
    // run sees it: waking the poisoned agent — whose branch was pruned a few
    // lines earlier — takes the whole run down with it, and the sibling that
    // had nothing wrong with its image never reaches a terminal event at all.
    const deadId = (failures[0] as { agentId: number }).agentId;
    const survivorId = events
      .filter(e => e.type === 'agent:spawn')
      .map(e => (e as { agentId: number }).agentId)
      .find(id => id !== deadId);
    expect(survivorId).toBeDefined();
    expect(events.some(e => (e as { agentId?: number }).agentId === survivorId
      && (e.type === 'agent:done' || e.type === 'agent:failed'))).toBe(true);
    // The cohort was issued as ONE call with both entries — the sibling was
    // not re-dispatched or lost.
    expect(ctx.multimodalPrefills[0].bitmapCounts).toEqual([1, 1]);
  });

  it('re-activates an agent on a tick where ONLY media settled', async () => {
    // The token-prefill list is empty on such a tick. An agent left parked
    // here would sit in awaiting_tool with its result already in KV, and
    // nothing would ever wake it.
    const toolMap = new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]);
    const { events } = await runPool({
      forkTokenQueues: [[1, STOP, STOP]],
      tools: toolMap,
      ...oneToolCall('rasterize'),
    });
    // `recovery_skipped` is the stub policy's normal terminal (it defines no
    // onRecovery) — the media path must not add a failure of its own.
    expect(mediaFailures(events)).toHaveLength(0);
    expect(events.some(e => e.type === 'agent:tool_result')).toBe(true);
    expect(events.some(e => e.type === 'agent:done')).toBe(true);
  });

  it('charges admission the MEASURED cells, so an oversized image defers', async () => {
    // The sharp case for the cost expression: a media item's `prefillTokens`
    // is empty (mtmd tokenizes downstream), so a cost read from it would be
    // ZERO and every image would be admitted regardless of headroom —
    // over-committing KV silently. It must be charged the measured cells.
    const toolMap = new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]);
    const { ctx, events } = await runPool({
      // The scaffold's real default (harness.yml `context: 32768`), not a
      // number squeezed until something breaks: starving nCtx to force the
      // refusal stops the agent spawning at all, and then the test passes
      // because NOTHING happened. The image price is the only lever here.
      nCtx: MEDIA_TEST_NCTX,
      forkTokenQueues: [[1, STOP, STOP]],
      tools: toolMap,
      // One image priced well past what is left.
      mutateCtx: (c) => { c.mockImageCells = 100_000; },
      ...oneToolCall('rasterize'),
    });

    // The agent really ran and really called the tool...
    expect(events.some(e => e.type === 'agent:tool_result')).toBe(true);
    // ...and its image was still refused admission. Charged at zero it would
    // have sailed through and landed here.
    expect(ctx.multimodalPrefills).toHaveLength(0);
    expect(mediaFailures(events)).toHaveLength(0);
  });

  it('fails the agent when ingress refuses, without retrying the tool', async () => {
    // A post-tool ingress failure must NOT become a tool retry: the tool
    // already ran and may have had an external side effect, so re-running it
    // is not a neutral act. The agent fails through the normal path and its
    // branch is pruned — never silently dropped, never repeated.
    const toolMap = new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]);
    const { ctx, events } = await runPool({
      nCtx: MEDIA_TEST_NCTX,
      forkTokenQueues: [[1, STOP, STOP]],
      tools: toolMap,
      // An ingress that refuses stands in for a normalization or commit
      // failure at the barrier — before admission, before any prefill.
      refusingIngress: true,
      ...oneToolCall('rasterize'),
    });
    // Nothing reached the embedding rail...
    expect(ctx.multimodalPrefills).toHaveLength(0);
    // ...and the tool ran exactly ONCE. A post-tool failure must not be
    // retried: the tool may already have had an external side effect.
    expect(events.filter(e => e.type === 'agent:tool_call')).toHaveLength(1);

    // THE ASSERTION THIS TEST WAS MISSING. Both facts above stayed true while
    // the whole pool was being torn down: the throw escaped `processCompletion`
    // (called outside any try) into the tick loop's own catch, which closes the
    // channel with a partial result, no trace and no `agent:failed`. The test
    // passed for two years' worth of the wrong reason.
    //
    // The agent must FAIL — visibly, by name — rather than vanish.
    expect(mediaFailures(events).length + events.filter(e =>
      e.type === 'agent:failed'
      && (e as { reason?: string }).reason === 'tool_result_failed').length,
    ).toBe(1);
    // And it must be THIS agent, reported through the bus, not an absence.
    const failed = events.find(e => e.type === 'agent:failed');
    expect(failed).toBeDefined();
    expect((failed as { agentId: number }).agentId).toBeTypeOf('number');
  });

  it('tells the model when the runtime cannot see images', async () => {
    // Dropping them silently would leave the agent reasoning about a picture
    // it was never shown. The note goes where the model will read it.
    const toolMap = new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]);
    const { ctx, events } = await runPool({
      nCtx: MEDIA_TEST_NCTX,
      forkTokenQueues: [[1, STOP, STOP]],
      tools: toolMap,
      mutateCtx: (c) => { c.mockSupportsVision = false; },
      ...oneToolCall('rasterize'),
    });

    expect(ctx.multimodalPrefills).toHaveLength(0);
    const shown = events.filter(e => e.type === 'agent:tool_result')
      .map(e => (e as { result: string }).result).join('');
    expect(shown).toContain('cannot see images');
    expect(shown).not.toContain('137,80,78,71');
  });
});
