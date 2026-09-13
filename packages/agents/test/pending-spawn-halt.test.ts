/**
 * A fork has one owner from forge to roster, and every way out of the pool
 * releases what was never admitted.
 *
 * `PoolContext.spawn` forks first and queues second; a heal's forge does the
 * same from the loop's observe. The roster receives a fork only at admission,
 * so between forge and roster the pool itself must own it — on a halt while a
 * batch holds the loop, on an exception after a batch's prefill, on the normal
 * close. Before the registry the roster's teardown prune never saw a fork that
 * was still queued, and only the executor's own window covered the batch in
 * flight: a fork queued while that batch was held outlived the pool (the
 * 2026-09-12 release review, R3).
 */
import { describe, it, expect } from 'vitest';
import { run, createChannel, spawn, all, until } from 'effection';
import type { Channel, Operation } from 'effection';
import { createMockSdk } from '../../sdk/src/testing.js';
import type { MockSessionContext } from '../../sdk/src/testing.js';
import { useAgentPool } from '../src/agent-pool';
import type { PoolContext } from '../src/orchestrators';
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

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const live = (ctx: MockSessionContext): number[] =>
  [...(ctx as unknown as { _branches: Map<number, { disposed: boolean }> })._branches]
    .filter(([, b]) => !b.disposed).map(([h]) => h);

/**
 * The fixture: a mock context whose FIRST single-branch prefill after the root's
 * own — agent `a`'s suffix — is held until the test releases it. `started`
 * resolves inside the hold; `forked` resolves when the second fork exists, so
 * the test knows `b` is queued without sleeping.
 */
async function fixture() {
  const { ctx, store, root } = createMockSdk({ nCtx: 8192, cellsUsed: 0 });
  await root.prefill(ctx.tokenizeSync('system prompt'));
  const started = deferred();
  const release = deferred();
  const forked = deferred();
  let held = false;
  const innerPrefill = ctx._storePrefill.bind(ctx);
  ctx._storePrefill = async (handles, tokenArrays) => {
    if (!held && handles.length === 1) {
      held = true;
      started.resolve();
      await release.promise;
    }
    return innerPrefill(handles, tokenArrays);
  };
  let forks = 0;
  const innerFork = ctx._branchFork.bind(ctx);
  ctx._branchFork = (parentHandle: number, ...rest: unknown[]) => {
    const h = (innerFork as (p: number, ...r: unknown[]) => number)(parentHandle, ...rest);
    if (++forks === 2) forked.resolve();
    return h;
  };
  return { ctx, store, root, started, release, forked };
}

function* contexts(ctx: MockSessionContext, store: ReturnType<typeof createMockSdk>['store']): Operation<void> {
  yield* Ctx.set(ctx as never);
  yield* Store.set(store);
  const events: Channel<AgentEvent, void> = createChannel();
  yield* Events.set(events as never);
  yield* Trace.set(new CapturingTraceWriter());
  const contentStore = new MemoryAttachmentStore();
  yield* Attachments.set(contentStore);
  yield* Ingress.set(rawIngress(contentStore));
}

/** `a` first; `b` once `a`'s prefill is being held. */
const twoSpawns = (started: Promise<void>) => function* (pc: PoolContext): Operation<void> {
  yield* all([
    pc.spawn({ content: 'a', systemPrompt: 'You are an agent.', seed: 0 }),
    (function* () {
      yield* until(started);
      return yield* pc.spawn({ content: 'b', systemPrompt: 'You are an agent.', seed: 1 });
    })(),
  ]);
};

describe('a fork queued while the loop is held', () => {
  it('is released by a halt of the pool: nothing but the root survives', async () => {
    const { ctx, store, root, started, release, forked } = await fixture();
    await run(function* () {
      yield* contexts(ctx, store);
      const task = yield* spawn(function* () {
        const sub = yield* useAgentPool({
          spine: root, orchestrate: twoSpawns(started.promise),
          toolsJson: '', tools: new Map(), policy, maxTurns: 10,
        });
        for (;;) { const n = yield* sub.next(); if (n.done) return; }
      });
      yield* until(started.promise);   // a's prefill holds the loop
      yield* until(forked.promise);    // b is forged and queued behind it
      const halting = task.halt();
      release.resolve();
      yield* halting;
    });
    expect(live(ctx), 'a queued fork outlived the pool').toEqual([root.handle]);
  });

  it('is released when a batch fails after its prefill: the pool closes partial with only roster branches alive', async () => {
    const { ctx, store, root, started, release, forked } = await fixture();
    // The eager grammar is installed on activation, after the batch prefill;
    // the mock refuses it, so `a`'s activation throws with `b` still queued.
    ctx._branchSetGrammar = () => { throw new Error('grammar install failed'); };
    let liveAtClose: number[] = [];
    let rosterA = -1;
    await run(function* () {
      yield* contexts(ctx, store);
      const sub = yield* useAgentPool({
        spine: root, orchestrate: twoSpawns(started.promise),
        toolsJson: '', tools: new Map(), policy, maxTurns: 10,
        eagerGrammar: 'root ::= "x"',
      });
      yield* spawn(function* () {
        yield* until(started.promise);
        yield* until(forked.promise);
        release.resolve();
      });
      for (;;) {
        const n = yield* sub.next();
        if (n.done) {
          rosterA = n.value.agents[0]?.agentId ?? -1;
          liveAtClose = live(ctx);   // the subscription closed; the pool's scope is still open
          return;
        }
      }
    });
    expect(rosterA, 'a entered the roster before its activation failed').toBeGreaterThan(0);
    expect(liveAtClose.sort(), 'the queued fork was not released at the partial close').toEqual([root.handle, rosterA].sort());
    expect(live(ctx), 'after the scope: nothing but the root').toEqual([root.handle]);
  });
});
