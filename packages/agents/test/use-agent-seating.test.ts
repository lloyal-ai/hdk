/**
 * `useAgent` seats one agent or fails by name. Its one spawn can be refused
 * (no sequence, no room) or lost to a failed prefill; either way the caller
 * hears the reason, never a missing roster entry.
 */
import { describe, it, expect } from 'vitest';
import { run, createChannel, scoped } from 'effection';
import type { Channel, Operation } from 'effection';
import { createMockSdk } from '../../sdk/src/testing.js';
import type { MockSessionContext } from '../../sdk/src/testing.js';
import { useAgent } from '../src/use-agent';
import { Ctx, Store, Events, Trace, Attachments, Ingress } from '../src/context';
import { MemoryAttachmentStore } from './helpers/memory-store';
import { rawIngress } from './helpers/raw-ingress';
import { CapturingTraceWriter } from './helpers/capturing-trace';
import type { AgentEvent } from '../src/types';

const STOP = 999;

async function world(opts: { nSeqMax?: number } = {}): Promise<{ ctx: MockSessionContext; store: ReturnType<typeof createMockSdk>['store']; root: ReturnType<typeof createMockSdk>['root']; trace: CapturingTraceWriter }> {
  const { ctx, store, root } = createMockSdk({ nCtx: 16384, nSeqMax: opts.nSeqMax });
  await root.prefill(ctx.tokenizeSync('system prompt'));
  ctx._branchSample = (): number => STOP;
  ctx.parseChatOutput = () => ({ content: 'an answer', reasoningContent: '', toolCalls: [] });
  return { ctx, store, root, trace: new CapturingTraceWriter() };
}

function* contexts(w: Awaited<ReturnType<typeof world>>): Operation<void> {
  yield* Ctx.set(w.ctx as never);
  yield* Store.set(w.store);
  const events: Channel<AgentEvent, void> = createChannel();
  yield* Events.set(events as never);
  yield* Trace.set(w.trace);
  const contentStore = new MemoryAttachmentStore();
  yield* Attachments.set(contentStore);
  yield* Ingress.set(rawIngress(contentStore));
}

describe('useAgent seating', () => {
  it('a spawn the pool cannot seat fails the caller by name, not by a missing roster entry', async () => {
    const w = await world({ nSeqMax: 2 });   // the root, and the one useAgent's own root takes: nothing left for the agent
    let caught: unknown = null;
    await run(function* () {
      yield* contexts(w);
      try {
        yield* scoped(() => useAgent({ systemPrompt: 'S', task: 'T', parent: w.root, acceptFreeText: true }));
      } catch (e) { caught = e; }
    });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/no_sequence/);
    expect((caught as Error).message).not.toMatch(/undefined/);
  });

  it("a spawn whose suffix prefill fails inside the pool carries that failure to the caller", async () => {
    const w = await world();
    const calls: number[] = [];
    w.ctx._storePrefill = async (h) => { calls.push(h.length); throw new Error('the suffix would not prefill'); };
    let caught: unknown = null;
    await run(function* () {
      yield* contexts(w);
      try {
        // Cold: no parent, so no turn separator — the first prefill is the spawn's suffix, inside the pool's tick.
        yield* scoped(() => useAgent({ systemPrompt: 'S', task: 'T', acceptFreeText: true }));
      } catch (e) { caught = e; }
    });
    expect(calls).toEqual([1]);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('the suffix would not prefill');
  });
});
