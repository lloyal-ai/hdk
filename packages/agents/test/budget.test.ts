/**
 * A budget row is every number one agent's turn obeys, as data; the pool derives
 * its policy and turn cap from it. The harness's guard overrides ride beside it.
 * The knobs a harness fixes once — per-token epistemics, pruning on return,
 * thinking — default from the `PoolDefaults` context, and an explicit pool
 * option still wins. `useAgent` keeps its agent's branch alive whatever the
 * context says: that is its contract.
 */
import { describe, it, expect } from 'vitest';
import { run, createChannel, scoped } from 'effection';
import type { Channel } from 'effection';
import type { ParsedToolCall } from '@lloyal-labs/sdk';
import { MockSessionContext, createMockSdk } from '../../sdk/src/testing.js';
import { DefaultAgentPolicy, policyFromBudget } from '../src/AgentPolicy';
import type { AgentPolicy } from '../src/AgentPolicy';
import { ContextPressure } from '../src/pressure';
import { useAgentPool } from '../src/agent-pool';
import { useAgent } from '../src/use-agent';
import { parallel } from '../src/orchestrators';
import { Ctx, Store, Events, Trace, PoolDefaults } from '../src/context';
import type { Agent } from '../src/Agent';
import type { AgentEvent, AgentPoolResult } from '../src/types';
import { CapturingTraceWriter } from './helpers/capturing-trace';
import { MockTool } from './helpers/mock-tool';

const STOP = 999;

const pressureAt = (percentAvailable: number): ContextPressure =>
  ({ critical: false, percentAvailable, headroom: 10_000, remaining: 20_000, hardLimit: 512, softLimit: 1024, canFit: () => true } as unknown as ContextPressure);
const agentWith = (over: Partial<{ startedAt: number; currentTool: string | null; turns: number; toolCallCount: number; result: string | null; tokenCount: number }>): Agent =>
  ({ startedAt: 0, currentTool: null, turns: 0, toolCallCount: 0, result: null, tokenCount: 0, ...over } as unknown as Agent);
const call = (name: string, args: object): ParsedToolCall => ({ id: 'c1', name, arguments: JSON.stringify(args) });
const PROMPT = { system: 'sys', user: 'usr' };

describe('policyFromBudget', () => {
  it('every field of the row reaches the policy, with the pool\'s terminal and the harness\'s guards', () => {
    let t = 0;
    const policy = policyFromBudget(
      {
        maxTurns: 7,                      // the pool's, not the policy's
        context: { softLimit: 3000, hardLimit: 1500 },
        time: { hardLimit: 100 },
        recovery: { prompt: PROMPT, minToolCalls: 0, minTokens: 0 },
        recoveryShape: 'parallel',
        recoveryBudget: 300,
        shouldExplore: { context: 0.9 },
      },
      { terminalToolName: 'report', guardOverrides: { fetch_limit: false } },
    );
    policy.bindClock(() => t);
    expect(policy).toBeInstanceOf(DefaultAgentPolicy);
    expect(policy.pressureThresholds).toEqual({ softLimit: 3000, hardLimit: 1500 });
    expect(policy.recoveryShape).toBe('parallel');
    expect(policy.recoveryBudget).toBe(300);
    expect(policy.guardOverrides).toEqual({ fetch_limit: false });
    // shouldExplore: 85% available is under the row's 0.9 floor (the default 0.4 would explore)
    expect(policy.shouldExplore(agentWith({}), pressureAt(85))).toBe(false);
    expect(new DefaultAgentPolicy().shouldExplore(agentWith({}), pressureAt(85))).toBe(true);
    // time hard limit, on the bound clock
    t = 100;
    expect(policy.shouldExit(agentWith({}), pressureAt(85))).toBe(true);
    // the pool's terminal protects an agent mid-report from that exit
    expect(policy.shouldExit(agentWith({ currentTool: 'report' }), pressureAt(85))).toBe(false);
    // a first-action report is a return: the evidence floor is the harness's hook, not a row number
    const cfg = { maxTurns: 7, terminalToolName: 'report' };
    expect(policy.onProduced(agentWith({}), { content: null, toolCalls: [call('report', { result: 'r' })] }, pressureAt(85), cfg))
      .toMatchObject({ type: 'return', result: 'r' }); // the call rides beside the result, for the terminal's own capture
    // recovery: the row's floors admit an agent with nothing yet
    expect(policy.onRecovery(agentWith({}), pressureAt(85)).type).toBe('extract');
  });

  it('an empty row is the default policy', () => {
    const policy = policyFromBudget({}, {});
    const stock = new DefaultAgentPolicy();
    expect(policy.pressureThresholds).toEqual(stock.pressureThresholds);
    expect(policy.recoveryShape).toBe(stock.recoveryShape);
    expect(policy.recoveryBudget).toBe(stock.recoveryBudget);
    expect(policy.guardOverrides).toBeUndefined();
    expect(policy.onRecovery(agentWith({ toolCallCount: 5, tokenCount: 500 }), pressureAt(85))).toEqual({ type: 'skip' });
  });
});

// ── The pool, on the mock ────────────────────────────────────────

/** A voluntary return through the terminal tool on the first turn — the one return
 *  `pruneOnReturn` acts on (a free-text return keeps its branch either way). */
const returnsViaReport: AgentPolicy = {
  onProduced: (_a, parsed) => parsed.toolCalls[0]?.name === 'report' ? { type: 'return', result: 'findings' } : { type: 'idle', reason: 'free_text_stop' },
  shouldExit: () => false,
  hooks: [{ beforeAdmit: () => ({ type: 'drop' }) }],
};
const report = new MockTool('report');
const withReport = { tools: new Map([['report', report]]), toolsJson: JSON.stringify([report.schema]), terminalToolName: 'report' } as const;

interface Boot { ctx: MockSessionContext; root: ReturnType<typeof createMockSdk>['root']; store: ReturnType<typeof createMockSdk>['store']; trace: CapturingTraceWriter }

/** Mock SDK wired so every fork produces one token then stops, parsed as content. */
async function boot(): Promise<Boot> {
  const { ctx, root, store } = createMockSdk({ nCtx: 16384, cellsUsed: 1000 });
  const sampled = new Map<number, number>();
  ctx._branchSample = (handle: number): number => {
    const n = sampled.get(handle) ?? 0;
    sampled.set(handle, n + 1);
    return n === 0 ? 1 : STOP;
  };
  ctx.parseChatOutput = () => ({ content: '', reasoningContent: '', toolCalls: [{ id: 'c1', name: 'report', arguments: JSON.stringify({ result: 'findings' }) }] });
  await root.prefill(ctx.tokenizeSync('system prompt'));
  return { ctx, root, store, trace: new CapturingTraceWriter() };
}

/** Run one pool and read its result INSIDE the scope, before teardown prunes what is left. */
async function pool(
  opts: Partial<Parameters<typeof useAgentPool>[0]>,
  defaults?: { trace?: boolean; pruneOnReturn?: boolean; enableThinking?: boolean },
): Promise<{ result: AgentPoolResult; disposedAtClose: boolean; trace: CapturingTraceWriter }> {
  const { ctx, root, store, trace } = await boot();
  return run(function* () {
    yield* Ctx.set(ctx as never);
    yield* Store.set(store);
    yield* Trace.set(trace);
    yield* Events.set(createChannel<AgentEvent, void>() as never);
    if (defaults) yield* PoolDefaults.set(defaults);
    return yield* scoped(function* () {
      const sub = yield* useAgentPool({
        spine: root,
        orchestrate: parallel([{ content: 'Task', systemPrompt: 'You are an agent.' }]),
        toolsJson: '',
        tools: new Map(),
        ...opts,
      } as Parameters<typeof useAgentPool>[0]);
      let next = yield* sub.next();
      while (!next.done) next = yield* sub.next();
      const result = next.value;
      return { result, disposedAtClose: result.agents[0]?.branch.disposed ?? false, trace };
    });
  });
}

describe('useAgentPool({ budget, guards })', () => {
  it('refuses a policy beside a budget or guards — a policy carries its own', async () => {
    await expect(pool({ policy: returnsViaReport, budget: { maxTurns: 3 } })).rejects.toThrow(/budget.*policy|policy.*budget/);
    await expect(pool({ policy: returnsViaReport, guards: { g: false } })).rejects.toThrow(/guards.*policy|policy.*guards/);
  });

  it('the row\'s maxTurns is the pool\'s turn cap; an explicit maxTurns still wins', async () => {
    const a = await pool({ budget: { maxTurns: 3 } });
    expect(a.trace.ofType('scope:open').find((e) => e.name === 'pool')?.meta?.maxTurns).toBe(3);
    const b = await pool({ budget: { maxTurns: 3 }, maxTurns: 5 });
    expect(b.trace.ofType('scope:open').find((e) => e.name === 'pool')?.meta?.maxTurns).toBe(5);
  });
});

describe('PoolDefaults', () => {
  it('trace: absent → no per-token trace; the context turns it on; an explicit false wins over the context', async () => {
    expect((await pool({ policy: returnsViaReport, ...withReport })).result.agents[0].trace).toBeUndefined();
    expect((await pool({ policy: returnsViaReport, ...withReport }, { trace: true })).result.agents[0].trace).toEqual(expect.any(Array));
    expect((await pool({ policy: returnsViaReport, ...withReport, trace: false }, { trace: true })).result.agents[0].trace).toBeUndefined();
  });

  it('pruneOnReturn: the context prunes a returned agent before the pool closes; an explicit false keeps it', async () => {
    const a = await pool({ policy: returnsViaReport, ...withReport });
    expect(a.result.agents[0].result).toBe('findings');
    expect(a.disposedAtClose).toBe(false);
    expect((await pool({ policy: returnsViaReport, ...withReport }, { pruneOnReturn: true })).disposedAtClose).toBe(true);
    expect((await pool({ policy: returnsViaReport, ...withReport, pruneOnReturn: false }, { pruneOnReturn: true })).disposedAtClose).toBe(false);
  });

  it('useAgent keeps its agent\'s branch alive under a context that prunes on return', async () => {
    const { ctx, store, trace } = await boot();
    const alive = await run(function* () {
      yield* Ctx.set(ctx as never);
      yield* Store.set(store);
      yield* Trace.set(trace);
      yield* Events.set(createChannel<AgentEvent, void>() as never);
      yield* PoolDefaults.set({ pruneOnReturn: true });
      return yield* scoped(function* () {
        const agent = yield* useAgent({ systemPrompt: 'You are an agent.', task: 'Task', tools: [report], terminal: report, policy: returnsViaReport });
        return { result: agent.result, disposed: agent.branch.disposed };
      });
    });
    expect(alive).toEqual({ result: 'findings', disposed: false });
  });
});
