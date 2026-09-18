/**
 * B0.9b — the terminal-tool hole, pinned where the real `ReportTool` lives.
 *
 * The pool never executes the terminal tool: its call is intercepted at the
 * policy (`_isTerminalTool`) and turned into the agent's return. That exclusion
 * is the POLICY's, not the executor's. A pool built without `terminalToolName`
 * therefore dispatches `report` like any tool, and `ReportTool.execute` — a
 * body that exists only to satisfy the interface — runs and admits `{}` as a
 * tool result. This is a known door (plan C3); it is pinned here so it is
 * visible in the suite, not only in the plan.
 *
 * Runs a real pool against the sdk's published mock; rig depends on agents, so
 * this is the one package where the real `ReportTool` can meet the pool.
 */
import { describe, it, expect } from 'vitest';
import { run, createChannel, scoped, spawn, each } from 'effection';
import type { Channel, Operation } from 'effection';
import { createMockSdk } from '@lloyal-labs/sdk/dist/testing.js';
import type { ParseChatOutputOptions, ParseChatOutputResult } from '@lloyal-labs/sdk';
import { useAgentPool, parallel, Ctx, Store, Events, Trace, NullTraceWriter, DefaultAgentPolicy } from '@lloyal-labs/lloyal-agents';
import type { AgentEvent, Tool } from '@lloyal-labs/lloyal-agents';
import { ReportTool } from '../src/tools/report';

const STOP = 999;

class SpyReport extends ReportTool {
  executed = 0;
  override *execute(): Operation<unknown> {
    this.executed++;
    return yield* super.execute();
  }
}

describe('B0.9b — a pool without a terminal dispatches the real ReportTool (the C3 door)', () => {
  it('report is dispatched, its execute runs, and an empty object is admitted as a tool result', async () => {
    const report = new SpyReport();
    const tools = new Map<string, Tool>([['report', report as Tool]]);
    const { ctx, store, root } = createMockSdk({ nCtx: 16384, cellsUsed: 1000 });

    const tokens = [1, STOP, STOP];
    let i = 0;
    ctx._branchSample = () => (i < tokens.length ? tokens[i++] : STOP);
    ctx.parseChatOutput = (raw: string, _f: unknown, opts?: ParseChatOutputOptions): ParseChatOutputResult => {
      if (opts?.isPartial || !raw.includes('t1')) return { content: raw ? 'done' : '', reasoningContent: '', toolCalls: [] };
      return { content: '', reasoningContent: '', toolCalls: [{ name: 'report', arguments: '{"result":"findings"}', id: 'c1' }] };
    };
    await root.prefill(ctx.tokenizeSync('system prompt'));

    const events: AgentEvent[] = [];
    await run(function* () {
      // The mock is the sdk's published dist entry; the pool's types resolve to sdk
      // source under the test project, so the two `Branch`/`BranchStore` declarations
      // are cast to meet. Runtime is one copy: agents dist over sdk dist.
      yield* Ctx.set(ctx as never);
      yield* Store.set(store as never);
      const ch: Channel<AgentEvent, void> = createChannel();
      yield* Events.set(ch as never);
      yield* Trace.set(new NullTraceWriter());
      yield* spawn(function* () { for (const ev of yield* each(ch)) { events.push(ev); yield* each.next(); } });
      return yield* scoped(function* () {
        const sub = yield* useAgentPool({
          spine: root as never,
          orchestrate: parallel([{ content: 'Task', systemPrompt: 'You are an agent.', seed: 0 }]),
          toolsJson: JSON.stringify([report.schema]),
          tools,
          // No terminal named: the one condition under which `report` reaches dispatch.
          policy: new DefaultAgentPolicy(),
          maxTurns: 5,
        });
        let next = yield* sub.next();
        while (!next.done) { events.push(next.value); next = yield* sub.next(); }
        return next.value;
      });
    });

    // The hole: the terminal tool's body ran.
    expect(report.executed).toBe(1);
    expect(events.filter((e) => e.type === 'agent:tool_call' && (e as { tool: string }).tool === 'report')).toHaveLength(1);
    // And what it returned — nothing but the framework's own meter — was admitted as a result.
    const shown = events.filter((e) => e.type === 'agent:tool_result' && (e as { tool: string }).tool === 'report') as Array<{ result: string }>;
    expect(shown).toHaveLength(1);
    const admitted = JSON.parse(shown[0].result) as Record<string, unknown>;
    expect(Object.keys(admitted).filter((k) => k !== '_contextAvailablePercent')).toEqual([]);
    // Nothing was returned the way a terminal call is.
    expect(events.some((e) => e.type === 'agent:return')).toBe(false);
  });
});
