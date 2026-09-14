/**
 * `useAgent` seats one agent or fails by name. Its one spawn can be refused
 * (no sequence, no room) or lost to a failed prefill; either way the caller
 * hears the reason, never a missing roster entry.
 *
 * Two more, which is the pool's LOGICAL-outcome contract read at N=1. The pool
 * carries two rosters: `agents` is physical, a heal's replacement standing
 * beside the original it replaced, and `outcomes` is logical, one entry per
 * spawn naming the lineage's final agent. `useAgent` promises one agent, so it
 * must read the logical one — and it must hand on a failure the pool recorded
 * even when a seat was taken, since a fatal AFTER seating leaves a roster entry
 * behind that looks exactly like success.
 */
import { describe, it, expect } from 'vitest';
import { run, createChannel, scoped } from 'effection';
import type { Channel, Operation } from 'effection';
import { createMockSdk } from '../../sdk/src/testing.js';
import type { MockSessionContext } from '../../sdk/src/testing.js';
import type { ChatFormat, ParseChatOutputOptions, ParseChatOutputResult } from '@lloyal-labs/sdk';
import { MediaTool, PNG_BYTES } from './helpers/media';
import type { Tool } from '../src/Tool';
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

  it('hands on a failure the pool recorded even though a seat was taken', async () => {
    // A decode that blows up mid-turn fails the pool AFTER the agent is on the
    // roster. Reading the roster first returns that agent — result and all — and
    // the reason the run ended is never spoken. The seat is not the question:
    // whether the pool finished is.
    const w = await world();
    let samples = 0;
    w.ctx._branchSample = (): number => (++samples <= 2 ? 1 : STOP);
    let commits = 0;
    const inner = w.ctx._storeCommit.bind(w.ctx);
    w.ctx._storeCommit = async (h, t) => {
      if (++commits >= 2) throw new Error('the commit blew up after the seat was taken');
      return inner(h, t);
    };
    let caught: unknown = null;
    let returned: unknown = undefined;
    await run(function* () {
      yield* contexts(w);
      try {
        returned = yield* scoped(() => useAgent({ systemPrompt: 'S', task: 'T', acceptFreeText: true }));
      } catch (e) { caught = e; }
    });
    expect(commits, 'the commit never threw — the scenario did not exercise a post-seating fatal').toBeGreaterThanOrEqual(2);
    expect(returned, 'the pool failed and an agent was handed back anyway').toBeUndefined();
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('the commit blew up after the seat was taken');
  });

  it("returns the lineage's final agent, not the disposed original a heal replaced", async () => {
    // A poisoned image prefill reaps the original and the pool forges a
    // replacement that replays its turns. Both sit on the physical roster, the
    // original first and disposed with no result. `outcomes[0]` names the
    // replacement, which is the one agent this spawn produced.
    const w = await world();
    let forkCount = 0;
    const forkIndex = new Map<number, number>();
    const sampleCount = new Map<number, number>();
    const origFork = w.ctx._branchFork.bind(w.ctx);
    w.ctx._branchFork = (parent: number): number => {
      const h = origFork(parent);
      forkIndex.set(h, forkCount++);
      sampleCount.set(h, 0);
      return h;
    };
    let last = 0;
    w.ctx._branchSample = (h: number): number => {
      last = h;
      const i = sampleCount.get(h) ?? 0;
      sampleCount.set(h, i + 1);
      return i === 0 ? 1 : STOP;
    };
    // Fork 0 asks for the image and is poisoned; its replacement answers.
    w.ctx.parseChatOutput = (_o: string, _f: ChatFormat, opts?: ParseChatOutputOptions): ParseChatOutputResult => {
      if (opts?.isPartial) return { content: '', reasoningContent: '', toolCalls: [] };
      return (forkIndex.get(last) ?? -1) === 0
        ? { content: '', reasoningContent: '', toolCalls: [{ name: 'rasterize', arguments: '{}', id: 'c1' }] }
        : { content: 'healed', reasoningContent: '', toolCalls: [] };
    };
    // The poison is the FIRST image prefill's alone — the replay must land, or no heal is reported.
    let images = 0;
    const innerMM = w.ctx._storePrefillMultimodal.bind(w.ctx);
    w.ctx._storePrefillMultimodal = async (h, sep, prompts, bitmaps) => {
      if (++images === 1) w.ctx.mockMultimodalError = () => ({ message: 'compute failed', rc: -3, partial: false });
      else delete (w.ctx as { mockMultimodalError?: unknown }).mockMultimodalError;
      return innerMM(h, sep, prompts, bitmaps);
    };
    let got: { id: number; result: string | null } | null = null;
    await run(function* () {
      yield* contexts(w);
      yield* scoped(function* () {
        const a = yield* useAgent({
          systemPrompt: 'S', task: 'T', acceptFreeText: true,
          tools: [new MediaTool([PNG_BYTES])] as unknown as Tool[],
        });
        got = { id: a.id, result: a.result };
      });
    });
    const heals = w.trace.events.filter(e => e.type === 'pool:agentHeal') as unknown as { of: number; agentId: number }[];
    expect(heals, 'no heal was reported — the scenario proves nothing').toHaveLength(1);
    expect(got, 'useAgent returned nothing').not.toBeNull();
    expect(got!.id, 'the disposed original was returned in place of its replacement').toBe(heals[0].agentId);
    expect(got!.result).toBe('healed');
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
