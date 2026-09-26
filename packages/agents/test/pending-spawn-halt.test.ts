/**
 * A fork has one owner from admission to roster, and every way out of the pool
 * releases what never entered it.
 *
 * `PoolContext.spawn` prices and queues; the executor forks an admitted request
 * and, after its prefill, enters it in the roster. Between fork and roster the
 * pool itself owns the fork — on a halt while a batch holds the loop, on an
 * exception after a batch's prefill, on the normal close. A request queued
 * while a batch is held is only a request: no fork exists for it to leak (the
 * 2026-09-12 release review, R3, and the admission move of the composition arc).
 */
import { describe, it, expect } from 'vitest';
import { run, createChannel, spawn, all, until, sleep } from 'effection';
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
 * resolves inside the hold; `requested` resolves when `b`'s request has been
 * priced (its chat formatted), so the test knows `b` is queued without sleeping.
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
  let formats = 0;
  const innerFormat = ctx.formatChatSync.bind(ctx);
  ctx.formatChatSync = (msgs, opts) => {
    const r = innerFormat(msgs, opts);
    if (++formats === 2) forked.resolve();   // `b` priced: queued as a request
    return r;
  };
  return { ctx, store, root, started, release, requested: forked };
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
  it('is a request, not a fork: a halt of the pool leaves nothing but the root', async () => {
    const { ctx, store, root, started, release, requested } = await fixture();
    let liveWhileHeld: number[] = [];
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
      yield* until(requested.promise); // b is priced and queued behind it
      liveWhileHeld = live(ctx);
      const halting = task.halt();
      release.resolve();
      yield* halting;
    });
    expect(liveWhileHeld, 'a queued request was forked before admission').toHaveLength(2);   // the root and a
    expect(live(ctx), 'a queued fork outlived the pool').toEqual([root.handle]);
  });

  it('is never forked when a batch fails after its prefill: the pool closes partial with only roster branches alive', async () => {
    const { ctx, store, root, started, release, requested } = await fixture();
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
        yield* until(requested.promise);
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
    expect(liveAtClose.sort(), 'a queued request was forked before admission').toEqual([root.handle, rosterA].sort());
    expect(live(ctx), 'after the scope: nothing but the root').toEqual([root.handle]);
  });
});

describe('a pool that has closed', () => {
  it('refuses new work at once: the producer is stopped, and a spawn or extend after the partial close rejects with no fork made', async () => {
    // The exception path closes the subscription. Before this, the orchestrator
    // lived on: a producer that woke after the close forged a branch and
    // suspended on an admission nobody would ever run, and the fork lived until
    // the enclosing scope exited. Closing is terminal for new work: the state
    // flips before anything is released, the orchestrator is halted (its late
    // child never gets its turn), and anyone still holding the PoolContext —
    // here the test, standing in for a stray producer — is refused outright.
    const { ctx, store, root, started, release } = await fixture();
    ctx._branchSetGrammar = () => { throw new Error('grammar install failed'); };
    let pc!: PoolContext;
    let orchestratorChildRan = false;
    let lateSpawn = 'not refused';
    let lateExtend = 'not refused';
    let liveAfterLateSpawn: number[] = [];
    await run(function* () {
      yield* contexts(ctx, store);
      const sub = yield* useAgentPool({
        spine: root,
        orchestrate: function* (ctx: PoolContext) {
          pc = ctx;
          yield* all([
            ctx.spawn({ content: 'a', systemPrompt: 'You are an agent.', seed: 0 }),
            (function* () { yield* sleep(1_000); orchestratorChildRan = true; })(),   // a child that would outlive the close
          ]);
        },
        toolsJson: '', tools: new Map(), policy, maxTurns: 10,
        eagerGrammar: 'root ::= "x"',
      });
      yield* spawn(function* () { yield* until(started.promise); release.resolve(); });
      for (;;) {
        const n = yield* sub.next();
        if (n.done) break;
      }
      // The pool has closed; the scope is still open. New work is refused, not queued.
      try { yield* pc.spawn({ content: 'b', systemPrompt: 'You are an agent.', seed: 1 }); lateSpawn = 'admitted'; }
      catch (e) { lateSpawn = (e as Error).message; }
      try { yield* pc.extendSpine('u', 'a'); lateExtend = 'admitted'; }
      catch (e) { lateExtend = (e as Error).message; }
      liveAfterLateSpawn = live(ctx);
    });
    expect(lateSpawn).toMatch(/closed/);
    expect(lateExtend).toMatch(/closed/);
    expect(orchestratorChildRan, 'the producer was not stopped at the close').toBe(false);
    expect(liveAfterLateSpawn.length, 'a spawn after the close forged a branch').toBe(2);   // root and a (roster), nothing else
    expect(live(ctx)).toEqual([root.handle]);
  });
});
