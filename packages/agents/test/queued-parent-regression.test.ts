import { it, expect } from 'vitest';
import { run, scoped, createChannel } from 'effection';
import { createMockSdk } from '../../sdk/src/testing';
import { useAgentPool } from '../src/agent-pool';
import { Ctx, Store, Events, Trace, Attachments, Ingress } from '../src/context';
import { MemoryAttachmentStore } from './helpers/memory-store';
import { rawIngress } from './helpers/raw-ingress';
import { CapturingTraceWriter } from './helpers/capturing-trace';
import { MockTool } from './helpers/mock-tool';

// Copy this file into packages/agents/test/ on either revision, then run:
// npx vitest run packages/agents/test/queued-parent-regression.test.ts --reporter verbose
// Base cf80b796: all cases pass; capacity was not implemented on that revision.
// Reviewed head 5e5ed6aa: capacity=1/prune=true fails; both controls pass.
it.each([
  { capacity: 1, pruneOnReturn: true },
  { capacity: 2, pruneOnReturn: true },
  { capacity: 1, pruneOnReturn: false },
])('a queued child retains its parent: capacity=$capacity prune=$pruneOnReturn', async ({ capacity, pruneOnReturn }) => {
  const { ctx, store, root } = createMockSdk({ nCtx: 32768 });
  const trace = new CapturingTraceWriter();
  const samples = new Map<number, number>();

  // Every physical branch emits one ordinary token and then a stop token.
  // The parser turns its completed output into the configured terminal call.
  ctx._branchSample = (handle: number) => {
    const n = samples.get(handle) ?? 0;
    samples.set(handle, n + 1);
    return n % 2 === 0 ? 7 : 999;
  };
  ctx.parseChatOutput = (_output, _format, options) => ({
    content: '',
    reasoningContent: '',
    toolCalls: options?.isPartial ? [] : [{
      name: 'report', arguments: '{"result":"done"}', id: 'report-call',
    }],
  });

  let parentAtRequest: { status: string; disposed: boolean } | undefined;
  const pool = await run(function* () {
    yield* Ctx.set(ctx as never);
    yield* Store.set(store);
    yield* Events.set(createChannel() as never);
    yield* Trace.set(trace);
    const content = new MemoryAttachmentStore();
    yield* Attachments.set(content);
    yield* Ingress.set(rawIngress(content));

    return yield* scoped(function* () {
      const stream = yield* useAgentPool({
        spine: root,
        toolsJson: '[]',
        tools: new Map([['report', new MockTool('report')]]),
        terminalToolName: 'report',
        capacity,
        pruneOnReturn,
        *orchestrate(pool) {
          const parent = yield* pool.spawn({ content: 'parent', systemPrompt: 's' });
          parentAtRequest = { status: parent.status, disposed: parent.branch.disposed };
          const child = yield* pool.spawn({
            content: 'child', systemPrompt: 's', parent: parent.branch,
          });
          yield* pool.waitFor(child);
        },
      });
      let next = yield* stream.next();
      while (!next.done) next = yield* stream.next();
      return next.value;
    });
  });

  expect(parentAtRequest).toEqual({ status: 'active', disposed: false });
  expect(pool.failure ?? null).toBe(null);
  expect(pool.agents.map((a) => a.result)).toEqual(['done', 'done']);
});
