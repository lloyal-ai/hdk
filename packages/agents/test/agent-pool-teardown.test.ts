import { describe, it, expect } from 'vitest';
import { run, spawn, sleep, until, createChannel, createSignal } from 'effection';
import type { Channel } from 'effection';
import { createMockSdk } from '../../sdk/src/testing.js';
import { useAgentPool } from '../src/agent-pool';
import { parallel } from '../src/orchestrators';
import { Ctx, Store, Events, Trace, Attachments, Ingress } from '../src/context';
import { MemoryAttachmentStore } from './helpers/memory-store';
import { rawIngress } from './helpers/raw-ingress';
import { CapturingTraceWriter } from './helpers/capturing-trace';
import type { AgentEvent } from '../src/types';
import type { AgentPolicy } from '../src/AgentPolicy';

const STOP = 999;

/**
 * A queued store decode keeps writing the context after the loop fiber is
 * halted. If pool teardown prunes while that call is in flight, two writers
 * touch one seq. The pool must let the in-flight commit SETTLE before it
 * prunes — bounded to one step or one prefill on the serial loop fiber.
 *
 * Red before waitUntilSettled wraps the store calls: on halt the loop fiber's
 * bare `until` is abandoned, `safePrune` runs while the commit is still
 * pending, and the recorded order is prune-before-settle.
 */
describe('pool teardown vs in-flight decode', () => {
  it('waits for an in-flight commit to settle before pruning', async () => {
    const { ctx, store, root } = createMockSdk({ nCtx: 16384, cellsUsed: 1000 });

    // One agent, two live tokens then stop → guarantees a COMMIT tick to hold.
    let forkCount = 0;
    const forkIndex = new Map<number, number>();
    const sampleCount = new Map<number, number>();
    const origFork = ctx._branchFork.bind(ctx);
    ctx._branchFork = (parent: number): number => {
      const h = origFork(parent);
      forkIndex.set(h, forkCount++);
      sampleCount.set(h, 0);
      return h;
    };
    ctx._branchSample = (h: number): number => {
      const i = sampleCount.get(h) ?? 0;
      sampleCount.set(h, i + 1);
      return i < 2 ? 100 + i : STOP; // T, T, STOP
    };

    const order: string[] = [];
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((r) => { releaseCommit = r; });
    let markIssued!: () => void;
    const issued = new Promise<void>((r) => { markIssued = r; });

    const origCommit = ctx._storeCommit.bind(ctx);
    let heldOnce = false;
    ctx._storeCommit = async (handles: number[], tokens: number[]): Promise<void> => {
      if (!heldOnce) {
        heldOnce = true;
        order.push('commit:issued');
        markIssued();
        await commitGate; // stand in for a long llama_decode still on the thread
        order.push('commit:settled');
      }
      return origCommit(handles, tokens);
    };
    const origPrune = ctx._branchPrune.bind(ctx);
    ctx._branchPrune = (h: number): void => { order.push('prune'); return origPrune(h); };

    const traceWriter = new CapturingTraceWriter();
    await root.prefill(ctx.tokenizeSync('system prompt'));

    await run(function* () {
      yield* Ctx.set(ctx as never);
      yield* Store.set(store);
      const events: Channel<AgentEvent, void> = createChannel();
      yield* Events.set(events as never);
      yield* Trace.set(traceWriter);
      const contentStore = new MemoryAttachmentStore();
      yield* Attachments.set(contentStore);
      yield* Ingress.set(rawIngress(contentStore));

      const drain = yield* spawn(function* () {
        const sub = yield* useAgentPool({
          spine: root,
          orchestrate: parallel([{ content: 'Task 0', systemPrompt: 'You are an agent.', seed: 0 }]),
          toolsJson: '',
          tools: new Map(),
          policy: { onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }) } as AgentPolicy,
          maxTurns: 100,
          pruneOnReturn: true,
        });
        let next = yield* sub.next();
        while (!next.done) next = yield* sub.next();
        return next.value;
      });

      yield* until(issued);          // a commit is now in flight
      const haltDone = drain.halt(); // begin teardown
      releaseCommit();               // let the held decode finish
      yield* until(haltDone);
    });

    const settled = order.indexOf('commit:settled');
    const firstPrune = order.indexOf('prune');
    expect(settled).toBeGreaterThanOrEqual(0);
    // The load-bearing assertion: no prune before the in-flight commit settled.
    expect(firstPrune === -1 || settled < firstPrune).toBe(true);
  });
});
