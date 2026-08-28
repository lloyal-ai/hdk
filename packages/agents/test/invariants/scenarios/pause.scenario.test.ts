/**
 * Scenario: pause/play (the Pause signal).
 *
 * Pause is a hold at the tick boundary — branches stay resident, nothing
 * decodes (I32), tool completions queue as data and settle on the first
 * tick after play, and the run completes normally afterwards. Time-based
 * policy budgets measure RUN time: a pause longer than the whole budget
 * kills no one.
 */
import { describe, it, expect } from 'vitest';
import { Tool } from '../../../src/Tool';
import type { Operation } from 'effection';
import { call } from 'effection';
import type { JsonSchema } from '../../../src/types';
import { DefaultAgentPolicy } from '../../../src/AgentPolicy';
import { I32_pauseHoldsNative, formatResult } from '../predicates';
import { runPool, STOP } from '../harness';

class SmallTool extends Tool<{ query: string }> {
  readonly name = 'web_search';
  readonly description = 'returns a small payload';
  readonly parameters: JsonSchema = { type: 'object', properties: { query: { type: 'string' } } };
  *execute(): Operation<unknown> { return { results: ['ok'] }; }
}

/** A fan-out tool whose completion the TEST controls — resolved from
 *  whilePaused to prove queued-while-frozen, settled-after-play. */
class DeferredTool extends Tool<{ query: string }> {
  readonly name = 'web_search';
  readonly description = 'completes when the test says so';
  readonly parameters: JsonSchema = { type: 'object', properties: { query: { type: 'string' } } };
  readonly fanout = true;
  resolve!: (v: unknown) => void;
  readonly done = new Promise<unknown>((r) => { this.resolve = r; });
  *execute(): Operation<unknown> { return yield* call(() => this.done); }
}

const toolSpec = {
  tokens: [1, STOP],
  toolCall: { name: 'web_search', arguments: '{"query":"q"}' },
};

describe('scenario: pause/play', () => {
  it('holds native work while paused (I32) and completes after play', async () => {
    const run = await runPool({
      nCtx: 16384, cellsUsed: 1000,
      scripts: [toolSpec],
      policy: new DefaultAgentPolicy({ terminalToolName: 'report' }),
      tools: new Map<string, Tool>([['web_search', new SmallTool()]]),
      terminalToolName: 'report', maxTurns: 5,
      pauseAfter: (ev) => ev.type === 'agent:spawn',
      whilePaused: async () => { /* just hold a beat */ },
    });
    expect(run.channelEvents.some(e => e.type === 'run:paused')).toBe(true);
    const resumed = run.channelEvents.find(e => e.type === 'run:resumed');
    expect(resumed && 'pausedMs' in resumed && resumed.pausedMs >= 0).toBe(true);
    const r = I32_pauseHoldsNative(run);
    expect(r.ok, formatResult('I32', r)).toBe(true);
    // the run still finished its work after play
    expect(run.channelEvents.some(e => e.type === 'agent:done')).toBe(true);
  });

  it('a tool completing DURING the pause settles on the first tick after play', async () => {
    const tool = new DeferredTool();
    const run = await runPool({
      nCtx: 16384, cellsUsed: 1000,
      scripts: [toolSpec],
      policy: new DefaultAgentPolicy({ terminalToolName: 'report' }),
      tools: new Map<string, Tool>([['web_search', tool]]),
      terminalToolName: 'report', maxTurns: 5,
      pauseAfter: (ev) => ev.type === 'agent:tool_call',
      whilePaused: async () => {
        tool.resolve({ results: ['landed while frozen'] });
        // give the child fiber a beat to push its completion
        await new Promise((r) => setTimeout(r, 30));
      },
    });
    const pausedIdx = run.channelEvents.findIndex(e => e.type === 'run:paused');
    const resumedIdx = run.channelEvents.findIndex(e => e.type === 'run:resumed');
    const resultIdx = run.channelEvents.findIndex(e => e.type === 'agent:tool_result');
    expect(pausedIdx).toBeGreaterThan(-1);
    expect(resultIdx).toBeGreaterThan(resumedIdx); // settled AFTER play, never inside the hold
    const r = I32_pauseHoldsNative(run);
    expect(r.ok, formatResult('I32', r)).toBe(true);
  });

  it('a pause longer than the whole time budget kills no one', async () => {
    const run = await runPool({
      nCtx: 16384, cellsUsed: 1000,
      scripts: [toolSpec],
      policy: new DefaultAgentPolicy({
        terminalToolName: 'report',
        budget: { time: { softLimit: 80, hardLimit: 120 } },
      }),
      tools: new Map<string, Tool>([['web_search', new SmallTool()]]),
      terminalToolName: 'report', maxTurns: 5,
      pauseAfter: (ev) => ev.type === 'agent:spawn',
      whilePaused: () => new Promise((r) => setTimeout(r, 200)), // ≫ hardLimit
    });
    // the agent survived a 200ms pause against a 120ms hard budget: run time
    // excluded the hold, so no policy_exit drop fired.
    const drops = run.traceEvents.filter(te => te.type === 'pool:agentDrop' && (te as { reason?: string }).reason === 'policy_exit');
    expect(drops).toHaveLength(0);
    expect(run.channelEvents.some(e => e.type === 'run:resumed')).toBe(true);
  });

  it('a cancel DURING the pause drops the agent live; siblings resume on play', async () => {
    let spawnedId: number | null = null;
    const run = await runPool({
      nCtx: 16384, cellsUsed: 1000,
      scripts: [toolSpec, toolSpec],
      taskCount: 2,
      policy: new DefaultAgentPolicy({ terminalToolName: 'report' }),
      tools: new Map<string, Tool>([['web_search', new SmallTool()]]),
      terminalToolName: 'report', maxTurns: 5,
      pauseAfter: (ev) => {
        if (ev.type === 'agent:spawn' && spawnedId === null) spawnedId = ev.agentId;
        return ev.type === 'agent:spawn';
      },
      whilePaused: async (h) => {
        h.cancel(spawnedId!);
        await new Promise((r) => setTimeout(r, 40)); // let the hold drain it
      },
    });
    const pausedIdx = run.channelEvents.findIndex(e => e.type === 'run:paused');
    const resumedIdx = run.channelEvents.findIndex(e => e.type === 'run:resumed');
    const failedIdx = run.channelEvents.findIndex(
      e => e.type === 'agent:failed' && (e as { reason?: string }).reason === 'user_cancel');
    // the drop landed INSIDE the hold — live feedback while frozen
    expect(failedIdx).toBeGreaterThan(pausedIdx);
    expect(failedIdx).toBeLessThan(resumedIdx);
    // the prune (reclamation) is traced inside the span; I32 still holds —
    // prune is not progression and was never in the ledger's ops
    const r = I32_pauseHoldsNative(run);
    expect(r.ok, formatResult('I32', r)).toBe(true);
    // the sibling still finished after play
    const doneAfterResume = run.channelEvents.filter(
      (e, idx) => e.type === 'agent:done' && idx > resumedIdx);
    expect(doneAfterResume.length).toBeGreaterThan(0);
  });
});
