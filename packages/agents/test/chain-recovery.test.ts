/**
 * A chain writes every stage's report to the spine, a recovered one included:
 * the next stage forks from it, and the settling pass reads it from there. A
 * stage whose agent stops without reporting, is dropped and recovers its
 * findings is a stage like any other.
 */
import { describe, it, expect } from 'vitest';
import { run, createChannel, scoped } from 'effection';
import type { Channel } from 'effection';
import { createMockSdk } from '../../sdk/src/testing.js';
import type { ParseChatOutputResult } from '@lloyal-labs/sdk';
import { useAgentPool } from '../src/agent-pool';
import { chain } from '../src/orchestrators';
import { Ctx, Store, Events, Trace, Attachments, Ingress } from '../src/context';
import { MemoryAttachmentStore } from './helpers/memory-store';
import { rawIngress } from './helpers/raw-ingress';
import { CapturingTraceWriter } from './helpers/capturing-trace';
import type { AgentPolicy } from '../src/AgentPolicy';
import type { AgentEvent, AgentPoolResult } from '../src/types';

const STOP = 999;
const REPORT = 100;

/** Every agent stops without a report, is dropped, and its recovery reports `findings <n>`. */
const recoversEveryStage: AgentPolicy = {
  shouldExit: () => false,
  onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
  onRecovery: () => ({ type: 'extract', prompt: { systemPrompt: 'Extract findings.', content: 'Report.' } }),
};

async function runChain(stages: number, room: { nCtx?: number; softLimit?: number; big?: { stage: number; report: string } } = {}): Promise<{ result: AgentPoolResult; trace: CapturingTraceWriter; events: AgentEvent[] }> {
  const { ctx, store, root } = createMockSdk({ nCtx: room.nCtx ?? 16384, cellsUsed: 1000 });
  // A branch stops at once, then its recovery writes the report token and stops. Stages are numbered by fork order.
  const stageOf = new Map<number, number>();
  const fork = ctx._branchFork.bind(ctx);
  ctx._branchFork = (parent: number): number => { const h = fork(parent); stageOf.set(h, stageOf.size + 1); return h; };
  const turns = new Map<number, number>();
  let sampled = 0;
  ctx._branchSample = (handle: number): number => {
    sampled = handle;
    const n = turns.get(handle) ?? 0;
    turns.set(handle, n + 1);
    return n === 1 ? REPORT : STOP;
  };
  const reportOf = (stage: number): string => (stage === room.big?.stage ? room.big.report : `findings ${stage}`);
  ctx.parseChatOutput = (raw: string): ParseChatOutputResult => (raw.includes(`t${REPORT}`)
    ? { content: '', reasoningContent: '', toolCalls: [{ id: 'c1', name: 'report', arguments: JSON.stringify({ result: reportOf(stageOf.get(sampled) ?? 0) }) }] }
    : { content: '', reasoningContent: '', toolCalls: [] });
  await root.prefill(ctx.tokenizeSync('system prompt'));
  const trace = new CapturingTraceWriter();
  const events: AgentEvent[] = [];
  const result = await run(function* () {
    yield* Ctx.set(ctx as never);
    yield* Store.set(store);
    const channel: Channel<AgentEvent, void> = createChannel();
    yield* Events.set(channel as never);
    yield* Trace.set(trace);
    const contentStore = new MemoryAttachmentStore();
    yield* Attachments.set(contentStore);
    yield* Ingress.set(rawIngress(contentStore));
    return yield* scoped(function* () {
      const sub = yield* useAgentPool({
        spine: root,
        orchestrate: chain(Array.from({ length: stages }, (_, i) => i), (i) => ({
          task: { content: `Task ${i}`, systemPrompt: 'Agent', seed: i },
          userContent: `Research task: ${i}`,
        })),
        toolsJson: '',
        tools: new Map(),
        terminalToolName: 'report',
        policy: room.softLimit !== undefined ? { ...recoversEveryStage, pressureThresholds: { softLimit: room.softLimit, hardLimit: 512 } } : recoversEveryStage,
        maxTurns: 10,
        recoveryShape: 'staggered',
      } as Parameters<typeof useAgentPool>[0]);
      let next = yield* sub.next();
      while (!next.done) { events.push(next.value); next = yield* sub.next(); }
      return next.value;
    });
  });
  return { result, trace, events };
}

describe('a chain whose stages recover their findings', () => {
  it('writes every recovered report to the spine, the last stage\'s included', async () => {
    const { result, trace } = await runChain(3);
    const recovered = result.outcomes.map((o) => o.result);
    expect(recovered.every((r) => r !== null && r.startsWith('findings'))).toBe(true);
    const extended = trace.ofType('spine:extend').map((e) => (e as { assistantContent: string }).assistantContent);
    expect(extended).toEqual(recovered);
  });

  // 6,000 cells, a soft line at 3,000: a ~3,000-token report has no room on the spine once the stage before it landed.
  const tooBig = 'findings' + ' word'.repeat(2400);
  const spineFull = (stage: number) => runChain(3, { nCtx: 6000, softLimit: 3000, big: { stage, report: tooBig } });
  const refusals = (trace: CapturingTraceWriter) => trace.ofType('spine:refused' as never) as unknown as { tokens: number }[];

  it('keeps a report the spine has no room for off it, and goes on: the next stage runs and is written', async () => {
    const { result, trace } = await spineFull(2);
    expect(result.failure).toBeNull();
    expect(result.outcomes.map((o) => o.result)).toEqual(['findings 1', tooBig, 'findings 3']);
    const extended = trace.ofType('spine:extend').map((e) => (e as { assistantContent: string }).assistantContent);
    expect(extended).toEqual(['findings 1', 'findings 3']);
    expect(refusals(trace)).toHaveLength(1);
    expect(refusals(trace)[0].tokens).toBeGreaterThan(2000);
  });

  it('a last report the spine has no room for is kept off it, and the pool closes whole, not partial', async () => {
    const { result, trace } = await spineFull(3);
    expect(result.failure).toBeNull();
    expect(result.outcomes.map((o) => o.result)).toEqual(['findings 1', 'findings 2', tooBig]);
    expect(trace.ofType('spine:extend').map((e) => (e as { assistantContent: string }).assistantContent)).toEqual(['findings 1', 'findings 2']);
    expect(refusals(trace)).toHaveLength(1);
    expect(trace.ofType('pool:close')).toHaveLength(1);
  });
});
