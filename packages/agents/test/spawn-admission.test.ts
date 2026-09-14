/**
 * The pool admits, forks and seats every spawn. A request carries a priced
 * suffix and no branch; the scheduler admits it when the KV fits, a sequence is
 * free and the pool is under `capacity`, and the executor forks the admitted
 * ones. What cannot be seated waits while a sibling can still free room, and is
 * refused with a named reason when none can. Every topology gets waves for
 * free; `parallel`, `chain`, `fanout` and `dag` stay the whole set of shapes.
 *
 * Outcomes are the pool's: one per spawn, in spawn order, across heals, read
 * back by `key`; `parallel`'s `afterDone` hears each as it settles, a refusal
 * included.
 */
import { describe, it, expect } from 'vitest';
import { run, createChannel, scoped, spawn, until } from 'effection';
import type { Channel, Operation } from 'effection';
import { createMockSdk } from '../../sdk/src/testing.js';
import type { MockSessionContext } from '../../sdk/src/testing.js';
import { useAgentPool, SpawnRefused } from '../src/agent-pool';
import { parallel } from '../src/orchestrators';
import type { PoolContext, SpawnSpec } from '../src/orchestrators';
import { Ctx, Store, Events, Trace, Attachments, Ingress } from '../src/context';
import { MemoryAttachmentStore } from './helpers/memory-store';
import { rawIngress } from './helpers/raw-ingress';
import { CapturingTraceWriter } from './helpers/capturing-trace';
import { MockTool } from './helpers/mock-tool';
import type { AgentPolicy } from '../src/AgentPolicy';
import type { AgentEvent, AgentPoolResult, SpawnOutcome } from '../src/types';
import { chain } from '../src/orchestrators';
import { runPool, STOP as RUN_STOP } from './invariants/harness';
import { MediaTool, PNG_BYTES, MEDIA_TEST_NCTX } from './helpers/media';

const STOP = 999;
const FILLER = 7;

/** A voluntary return through the terminal tool once the filler runs out — the return `pruneOnReturn` acts on. */
const report = new MockTool('report');
const returnsViaReport: AgentPolicy = {
  onProduced: (_a, parsed) => parsed.toolCalls[0]?.name === 'report'
    ? { type: 'return', result: JSON.parse(parsed.toolCalls[0].arguments).result as string }
    : { type: 'idle', reason: 'free_text_stop' },
  onRecovery: () => ({ type: 'skip' }),
  shouldExit: () => false,
};

const live = (ctx: MockSessionContext): number[] =>
  [...(ctx as unknown as { _branches: Map<number, { disposed: boolean }> })._branches].filter(([, b]) => !b.disposed).map(([h]) => h);

const spec = (i: number, key?: string): SpawnSpec => ({ content: `task ${i}`, systemPrompt: 'You are an agent.', seed: i, ...(key ? { key } : {}) });

interface World {
  ctx: MockSessionContext; root: ReturnType<typeof createMockSdk>['root']; store: ReturnType<typeof createMockSdk>['store'];
  trace: CapturingTraceWriter; events: AgentEvent[];
  /** The most agent branches alive at once (the root excluded). */
  maxLive: () => number;
}

/** A mock where every fork streams `stall` filler tokens, then stops with the text `done:<handle>`. */
async function world(opts: { nSeqMax?: number; nCtx?: number; stall?: number } = {}): Promise<World> {
  const { ctx, store, root } = createMockSdk({ nCtx: opts.nCtx ?? 16384, nSeqMax: opts.nSeqMax });
  await root.prefill(ctx.tokenizeSync('system prompt'));
  const produced = new Map<number, number>();
  let last = 0;
  let max = 0;
  const innerFork = ctx._branchFork.bind(ctx);
  ctx._branchFork = (parent: number, ...rest: unknown[]) => {
    const h = (innerFork as (p: number, ...r: unknown[]) => number)(parent, ...rest);
    max = Math.max(max, live(ctx).length - 1);
    return h;
  };
  ctx._branchSample = (handle: number): number => {
    last = handle;
    const n = produced.get(handle) ?? 0;
    produced.set(handle, n + 1);
    return n < (opts.stall ?? 2) ? FILLER : STOP;
  };
  ctx.parseChatOutput = (_o, _f, o) => (o?.isPartial
    ? { content: '', reasoningContent: '', toolCalls: [] }
    : { content: '', reasoningContent: '', toolCalls: [{ id: 'c1', name: 'report', arguments: JSON.stringify({ result: `done:${last}` }) }] });
  return { ctx, root, store, trace: new CapturingTraceWriter(), events: [], maxLive: () => max };
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

/** Run one pool to its close and return its result. */
function* pool(w: World, opts: Partial<Parameters<typeof useAgentPool>[0]>): Operation<AgentPoolResult> {
  return yield* scoped(function* () {
    const sub = yield* useAgentPool({
      spine: w.root, toolsJson: JSON.stringify([report.schema]), tools: new Map([['report', report]]), terminalToolName: 'report',
      policy: returnsViaReport, maxTurns: 10, pruneOnReturn: true,
      orchestrate: parallel([]),
      ...opts,
    } as Parameters<typeof useAgentPool>[0]);
    let next = yield* sub.next();
    while (!next.done) { w.events.push(next.value); next = yield* sub.next(); }
    return next.value;
  });
}

describe('admission in waves', () => {
  it('a parallel of six under capacity: 2 seats at most two at a time, and every spawn settles in order', async () => {
    const w = await world({ stall: 3 });
    const done: [number, SpawnOutcome][] = [];
    const result = await run(function* () {
      yield* contexts(w);
      return yield* pool(w, {
        capacity: 2,
        orchestrate: parallel([0, 1, 2, 3, 4, 5].map((i) => spec(i)), { *afterDone(i, o) { done.push([i, o]); } }),
      });
    });
    expect(w.maxLive()).toBe(2);
    expect(result.agents).toHaveLength(6);
    expect(result.outcomes).toHaveLength(6);
    expect(result.outcomes.map((o) => o.agentId)).toEqual(result.agents.map((a) => a.agentId));
    expect(result.outcomes.every((o) => o.result?.startsWith('done:') && o.failed === null)).toBe(true);
    expect(done.map(([i]) => i).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(done.every(([, o]) => o.result?.startsWith('done:'))).toBe(true);
  });

  it('a request forks nothing until it is admitted', async () => {
    const w = await world({ stall: 1 });
    // Hold the first agent's suffix prefill: the pool is mid-tick with one seat taken.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let holding = false;
    let started!: () => void;
    const startedP = new Promise<void>((r) => { started = r; });
    const inner = w.ctx._storePrefill.bind(w.ctx);
    w.ctx._storePrefill = async (handles, tokens) => {
      if (!holding && handles.length === 1 && handles[0] !== w.root.handle) { holding = true; started(); await held; }
      return inner(handles, tokens);
    };
    let liveWhileHeld: number[] = [];
    await run(function* () {
      yield* contexts(w);
      const running = yield* spawn(() => pool(w, { capacity: 1, orchestrate: parallel([0, 1, 2, 3].map((i) => spec(i))) }));
      yield* until(startedP);
      liveWhileHeld = live(w.ctx);
      release();
      yield* running;
    });
    // One fork for the admitted spawn; three requests waited as requests, not as forks.
    expect(liveWhileHeld).toHaveLength(2);
    expect(w.maxLive()).toBe(1);
  });

  it('a parallel wider than the sequence budget runs in waves at exact capacity, and nothing is refused', async () => {
    const w = await world({ nSeqMax: 3, stall: 3 });   // the root holds one: two seats
    const result = await run(function* () {
      yield* contexts(w);
      return yield* pool(w, { orchestrate: parallel([0, 1, 2, 3, 4].map((i) => spec(i))) });
    });
    expect(w.maxLive()).toBe(2);
    expect(result.outcomes.map((o) => o.failed)).toEqual([null, null, null, null, null]);
    expect(w.trace.ofType('pool:spawnRefused')).toEqual([]);
  });

  it('a fork the context cannot seat waits while a sibling can free room, and the pool never forks blind', async () => {
    // Room for one agent's suffix at a time: 'S'.repeat(6000) ≈ 1500 tokens each; under a 3072 context the
    // second does not fit the headroom (softLimit 1024) while the first holds its cells.
    const w = await world({ nCtx: 3072, stall: 2 });
    const wide = (i: number): SpawnSpec => ({ content: `task ${i}`, systemPrompt: 'S'.repeat(6000), seed: i });
    const result = await run(function* () {
      yield* contexts(w);
      return yield* pool(w, { orchestrate: parallel([wide(0), wide(1)]) });
    });
    expect(w.maxLive()).toBe(1);
    expect(result.outcomes.map((o) => o.failed)).toEqual([null, null]);
  });

  it('with the sequences held by retained ancestors and nothing that can free one, the spawn is refused as no_sequence — an outcome, not a throw', async () => {
    const w = await world({ nSeqMax: 2 });   // the root, and one more
    const done: [number, SpawnOutcome][] = [];
    let refusal: unknown = null;
    const result = await run(function* () {
      yield* contexts(w);
      return yield* pool(w, {
        *orchestrate(ctx: PoolContext) {
          const held = ctx.spine.forkSync();           // the last lease, retained for the pool's life
          try {
            yield* parallel([spec(0)], { *afterDone(i, o) { done.push([i, o]); } })(ctx);
            try { yield* ctx.spawn(spec(1)); } catch (e) { refusal = e; }
          } finally {
            held.pruneSync();
          }
        },
      });
    });
    expect(done).toEqual([[0, { key: undefined, agentId: null, result: null, exitReason: undefined, failed: 'no_sequence' }]]);
    expect(result.outcomes.map((o) => o.failed)).toEqual(['no_sequence', 'no_sequence']);
    expect(refusal).toBeInstanceOf(SpawnRefused);
    expect((refusal as SpawnRefused).reason).toBe('no_sequence');
    expect(w.trace.ofType('pool:spawnRefused').map((e) => e.reason)).toEqual(['no_sequence', 'no_sequence']);
    expect(w.trace.ofType('branch:create').filter((e) => e.role === 'agentFork')).toHaveLength(0);
  });

  it('a spawn the context can never seat is refused as pressure_init once nothing can free room', async () => {
    const w = await world({ nCtx: 3072, stall: 1 });
    const result = await run(function* () {
      yield* contexts(w);
      // pruneOnReturn off: the finished sibling keeps its branch, so nothing frees room.
      return yield* pool(w, { pruneOnReturn: false, orchestrate: parallel([spec(0), { content: 'x', systemPrompt: 'S'.repeat(20_000), seed: 1 }]) });
    });
    expect(result.outcomes.map((o) => o.failed)).toEqual([null, 'pressure_init']);
    expect(w.trace.ofType('pool:spawnRefused').map((e) => e.reason)).toEqual(['pressure_init']);
  });
});

describe('outcomes and keys', () => {
  it('a repeated key within one pool is refused as a programming error: the orchestrator fails and the pool closes partial; keyless spawns each get their own outcome; byKey reads one back', async () => {
    const w = await world();
    // An orchestrator that throws closes the pool with what exists and no `pool:close` record — the pool's standing contract.
    const partial = await run(function* () {
      yield* contexts(w);
      return yield* pool(w, { orchestrate: parallel([spec(0, 'k'), spec(1, 'k')]) });
    });
    expect(partial.outcomes.map((o) => o.key)).toEqual(['k']);
    expect(w.trace.ofType('pool:close')).toEqual([]);
    expect(partial.failure?.message).toMatch(/spawn key "k" is already taken/);

    const w2 = await world();
    const result = await run(function* () {
      yield* contexts(w2);
      return yield* pool(w2, { orchestrate: parallel([spec(0), spec(1), spec(2, 'third')]) });
    });
    expect(result.outcomes).toHaveLength(3);
    expect(result.outcomes.map((o) => o.key)).toEqual([undefined, undefined, 'third']);
    expect(result.byKey('third')).toEqual(result.outcomes[2]);
    expect(result.byKey('missing')).toBeUndefined();
    const spawns = w2.events.filter((e) => e.type === 'agent:spawn') as { key?: string }[];
    expect(spawns.map((s) => s.key)).toEqual([undefined, undefined, 'third']);
  });
});

describe('lineage', () => {
  it('a heal mid-run is delivered once under the original spawn: waitFor resolves to the replacement, chain extends with its result, one outcome', async () => {
    const run = await runPool({
      nCtx: MEDIA_TEST_NCTX, cellsUsed: 0, captureError: true,
      // Fork order: the original (calls the tool, is poisoned), then its replacement (free text).
      scripts: [
        { tokens: [1, RUN_STOP], toolCall: { name: 'rasterize', arguments: '{}' } },
        { tokens: [1, RUN_STOP], content: 'healed' },
      ],
      tools: new Map([['rasterize', new MediaTool([PNG_BYTES])]]),
      policy: {
        onProduced: (_a, parsed) => parsed.toolCalls.length > 0
          ? { type: 'tool_call', tc: parsed.toolCalls[0] }
          : parsed.content ? { type: 'free_text_return', content: parsed.content } : { type: 'idle', reason: 'free_text_stop' },
        onRecovery: () => ({ type: 'skip' }),
        shouldExit: () => false,
      },
      orchestrate: chain([0], () => ({ task: { content: 'Task 0', systemPrompt: 'You are an agent.', seed: 0, key: 'only' }, userContent: 'Task 0' })),
      instrument: (ctx) => { ctx.mockMultimodalError = () => ({ message: 'compute failed', rc: -3, partial: false }); },
    });
    expect(run.error, `the pool threw: ${String((run.error as Error)?.message ?? run.error)}`).toBeUndefined();
    const heals = run.traceEvents.filter((e) => e.type === 'pool:agentHeal') as { agentId: number; of: number }[];
    expect(heals).toHaveLength(1);
    const replacement = heals[0].agentId;
    expect(run.result.agents).toHaveLength(2);
    expect(run.result.outcomes).toEqual([{ key: 'only', agentId: replacement, result: 'healed', exitReason: undefined, failed: null }]);
    expect(run.result.byKey('only')?.result).toBe('healed');
    const extended = run.traceEvents.filter((e) => e.type === 'spine:extend') as { assistantContent: string }[];
    expect(extended.map((e) => e.assistantContent)).toEqual(['healed']);
  });
});
