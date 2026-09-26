/**
 * A spawn batch's forks are owned by the executor until they enter the
 * roster — on EVERY path out of that window, the halt included.
 *
 * The batch prefill is a native call the loop suspends on. A halt of the pool
 * during it (teardown, a partial close) unwinds the executor without visiting
 * any catch: the forks were in the schedule, not yet in the roster, so the
 * pool's teardown never saw them and their sequence leases leaked. Since the
 * Effection alignment a halt mid-decode actually unwinds, so this is the live
 * path, not a theoretical one.
 */
import { describe, it, expect } from 'vitest';
import { run, createChannel, spawn, sleep } from 'effection';
import type { Channel } from 'effection';
import { createMockSdk } from '../../sdk/src/testing.js';
import { useAgentPool } from '../src/agent-pool';
import { parallel } from '../src/orchestrators';
import { Ctx, Store, Events, Trace, Attachments, Ingress } from '../src/context';
import { MemoryAttachmentStore } from './helpers/memory-store';
import { rawIngress } from './helpers/raw-ingress';
import { CapturingTraceWriter } from './helpers/capturing-trace';
import type { AgentPolicy } from '../src/AgentPolicy';
import type { AgentEvent } from '../src/types';

const policy: AgentPolicy = {
  onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
  onRecovery: () => ({ type: 'skip' }),
  shouldExit: () => false,
};

describe('a pool halted during its spawn batch', () => {
  it('leaves no fork alive: nothing but the root survives', async () => {
    const { ctx, store, root } = createMockSdk({ nCtx: 8192, cellsUsed: 0 });
    await root.prefill(ctx.tokenizeSync('system prompt'));
    let batchSeen = false;
    const inner = ctx._storePrefill.bind(ctx);
    ctx._storePrefill = async (handles, tokenArrays) => {
      if (handles.length >= 2) { batchSeen = true; await new Promise(r => setTimeout(r, 30)); }
      return inner(handles, tokenArrays);
    };

    await run(function* () {
      yield* Ctx.set(ctx as never);
      yield* Store.set(store);
      const events: Channel<AgentEvent, void> = createChannel();
      yield* Events.set(events as never);
      yield* Trace.set(new CapturingTraceWriter());
      const contentStore = new MemoryAttachmentStore();
      yield* Attachments.set(contentStore);
      yield* Ingress.set(rawIngress(contentStore));
      const task = yield* spawn(function* () {
        const sub = yield* useAgentPool({
          spine: root, orchestrate: parallel([
            { content: 'a', systemPrompt: 'You are an agent.', seed: 0 },
            { content: 'b', systemPrompt: 'You are an agent.', seed: 1 },
          ]),
          toolsJson: '', tools: new Map(), policy, maxTurns: 10,
        });
        for (;;) { const n = yield* sub.next(); if (n.done) return; }
      });
      yield* sleep(10);           // inside the batch prefill
      yield* task.halt();
    });

    expect(batchSeen, 'the spawn batch never started').toBe(true);
    const live = [...(ctx as unknown as { _branches: Map<number, { disposed: boolean }> })._branches]
      .filter(([, b]) => !b.disposed).map(([h]) => h);
    expect(live, 'forks outlived the pool').toEqual([root.handle]);
  });
});
