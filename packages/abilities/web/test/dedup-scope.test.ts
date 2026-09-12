/**
 * The behaviour twin of the gate declaration, on a real pool: the same
 * `fetch_page` admits a sibling's repeat under the framework's lineage default
 * (the spreadsheet's shape), refuses it once the harness re-scopes `url_dedup`
 * to the cohort (research's `defaults.guards`), and admits it again when the
 * harness switches the gate off. Fetching itself is canned; the declaration and
 * the pool are real.
 *
 * Runs the published agents build over the sdk's published mock, the way the
 * rig's pool tests do.
 */
import { describe, it, expect } from 'vitest';
import { run, createChannel, scoped, spawn, each } from 'effection';
import type { Channel, Operation } from 'effection';
import { createMockSdk } from '@lloyal-labs/sdk/dist/testing.js';
import type { ParseChatOutputOptions, ParseChatOutputResult } from '@lloyal-labs/sdk';
import { useAgentPool, parallel, Ctx, Store, Events, Trace, DefaultAgentPolicy } from '@lloyal-labs/lloyal-agents';
import type { AgentEvent, Tool, TraceWriter, TraceEvent, TraceId, GuardOverrides } from '@lloyal-labs/lloyal-agents';
import { FetchPageTool } from '../src/tools/fetch-page';

const STOP = 999;
const URL = 'https://example.test/same-page';

/** The real `fetch_page` — its declaration, its trimming — with the network replaced by a canned page. */
class CannedFetch extends FetchPageTool {
  calls: string[] = [];
  *execute(args: { url: string; query?: string }): Operation<unknown> {
    this.calls.push(args.url);
    return { url: args.url, title: 'Page', content: 'text' };
  }
}

class Capture implements TraceWriter {
  events: TraceEvent[] = [];
  private id = 0;
  write(e: TraceEvent): void { this.events.push(e); }
  nextId(): TraceId { return ++this.id as TraceId; }
  flush(): void {}
}

/** Two agents fetch the same URL: A on its first turn, B after generating for a while, so A's result is booked before B's call is judged. */
async function twoAgentsFetchTheSamePage(guardOverrides?: GuardOverrides) {
  const fetchPage = new CannedFetch();
  const tools = new Map<string, Tool>([['fetch_page', fetchPage as Tool]]);
  const { ctx, store, root } = createMockSdk({ nCtx: 16384, cellsUsed: 1000 });

  const queues = [[1, STOP, STOP], [7, 7, 7, 7, 7, 7, 7, 7, 2, STOP, STOP]];
  let forks = 0;
  const forkIndex = new Map<number, number>();
  const sampled = new Map<number, number>();
  const origFork = ctx._branchFork.bind(ctx);
  ctx._branchFork = (parent: number): number => { const h = origFork(parent); forkIndex.set(h, forks++); sampled.set(h, 0); return h; };
  ctx._branchSample = (h: number): number => {
    const q = queues[forkIndex.get(h) ?? -1] ?? [STOP];
    const i = sampled.get(h) ?? 0;
    sampled.set(h, i + 1);
    return i < q.length ? q[i] : STOP;
  };
  ctx.parseChatOutput = (raw: string, _f: unknown, opts?: ParseChatOutputOptions): ParseChatOutputResult => {
    if (opts?.isPartial) return { content: '', reasoningContent: '', toolCalls: [] };
    const turn = raw.includes('t1') ? 'c1' : raw.includes('t2') ? 'c2' : null;
    if (turn) return { content: '', reasoningContent: '', toolCalls: [{ name: 'fetch_page', arguments: JSON.stringify({ url: URL }), id: turn }] };
    return { content: 'done', reasoningContent: '', toolCalls: [] };
  };
  await root.prefill(ctx.tokenizeSync('system prompt'));

  const trace = new Capture();
  const result = await run(function* () {
    yield* Ctx.set(ctx as never);
    yield* Store.set(store as never);
    const ch: Channel<AgentEvent, void> = createChannel();
    yield* Events.set(ch as never);
    yield* Trace.set(trace);
    yield* spawn(function* () { for (const ev of yield* each(ch)) { void ev; yield* each.next(); } });
    return yield* scoped(function* () {
      const sub = yield* useAgentPool({
        spine: root as never,
        orchestrate: parallel([{ content: 'A', systemPrompt: 's', seed: 0 }, { content: 'B', systemPrompt: 's', seed: 1 }]),
        toolsJson: JSON.stringify([fetchPage.schema]),
        tools,
        policy: new DefaultAgentPolicy({ terminalToolName: 'report', minToolCallsBeforeReturn: 0, guardOverrides }),
        terminalToolName: 'report',
        maxTurns: 10,
      });
      let next = yield* sub.next();
      while (!next.done) next = yield* sub.next();
      return next.value;
    });
  });
  const nudges = trace.events.filter((e) => e.type === 'pool:agentNudge') as Array<{ agentId: number; guard?: string }>;
  return { fetchPage, nudges, agents: result.agents };
}

describe("fetch_page's url_dedup on a real pool: the harness decides the scope", () => {
  it('lineage (the default): a sibling\'s repeat is admitted — two fetches, no nudge', async () => {
    const { fetchPage, nudges, agents } = await twoAgentsFetchTheSamePage();
    expect(fetchPage.calls).toEqual([URL, URL]);
    expect(nudges).toEqual([]);
    expect(agents.map((a) => a.agent.attendedResults('fetch_page').length)).toEqual([1, 1]);
  });

  it("cohort (research's `defaults.guards`): the sibling's repeat is refused under the gate's name", async () => {
    const { fetchPage, nudges, agents } = await twoAgentsFetchTheSamePage({ url_dedup: { scope: 'cohort' } });
    expect(fetchPage.calls).toEqual([URL]);
    expect(nudges).toEqual([expect.objectContaining({ agentId: agents[1].agentId, guard: 'url_dedup' })]);
    expect(agents[1].agent.attendedResults('fetch_page')).toEqual([]);
  });

  it('off (`url_dedup: false`): nothing is refused', async () => {
    const { fetchPage, nudges } = await twoAgentsFetchTheSamePage({ url_dedup: false });
    expect(fetchPage.calls).toEqual([URL, URL]);
    expect(nudges).toEqual([]);
  });
});
