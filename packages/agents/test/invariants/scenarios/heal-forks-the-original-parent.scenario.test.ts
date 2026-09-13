/**
 * Scenario: a heal forks the original's parent at the original's fork point —
 * or stands down.
 *
 * A replacement replays the original's own turns onto a fresh fork. Those
 * turns are everything AFTER the fork, so the fork must give the replacement
 * the same prefix the original had: the same parent, at the same position.
 * The pool used to fork every replacement off the spine regardless of the
 * `parent` the spawn named (the 2026-09-12 release review, R4): an agent
 * forked from an advanced branch was "healed" onto a prefix it never had,
 * and reported as reconstructed.
 *
 * Two arms. (1) The parent is still where the original left it: the
 * replacement forks it there, and `agent:spawn` names it. (2) The parent has
 * moved on since the fork: the prefix cannot be reproduced, so the heal
 * stands down — the original's failure stands, no `pool:agentHeal`, no fork.
 */
import { describe, it, expect } from 'vitest';
import { spawn, until } from 'effection';
import type { Operation } from 'effection';
import type { Branch } from '@lloyal-labs/sdk';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import type { PoolContext } from '../../../src/orchestrators';
import type { Tool } from '../../../src/Tool';
import { waitUntilSettled } from '../../../src/combinators';
import { runPool, STOP } from '../harness';
import { MediaTool, PNG_BYTES, MEDIA_TEST_NCTX, mediaFailures } from '../../helpers/media';
import { I42_noLeakedBranches, formatResult } from '../predicates';

const policy: AgentPolicy = {
  onProduced: (_a, parsed) => parsed.toolCalls.length > 0
    ? { type: 'tool_call', tc: parsed.toolCalls[0] }
    : { type: 'idle', reason: 'free_text_stop' },
  onRecovery: () => ({ type: 'skip' }),
  shouldExit: () => false,
};

/** Fork `P` off the spine and advance it, so an agent forked from `P` has a
 *  prefix the spine does not. `after` runs once the agent is admitted. */
function withParent(after?: (P: Branch) => Operation<void>) {
  const held: { P: Branch | null } = { P: null };
  const orchestrate = function* (ctx: PoolContext): Operation<void> {
    const P = ctx.spine.forkSync();
    held.P = P;
    yield* waitUntilSettled(P.prefill([7, 7, 7, 7, 7, 7, 7, 7]));
    const a = yield* ctx.spawn({ content: 'Task 0', systemPrompt: 'You are an agent.', seed: 0, parent: P });
    if (after) yield* after(P);
    yield* ctx.waitFor(a);
  };
  return { held, orchestrate };
}

const spec = (orchestrate: (ctx: PoolContext) => Operation<void>) => ({
  nCtx: MEDIA_TEST_NCTX, cellsUsed: 0,
  captureError: true as const,
  // Fork order: P (never samples), the original, the replacement.
  scripts: [
    { tokens: [STOP] },
    { tokens: [1, STOP], toolCall: { name: 'rasterize', arguments: '{}' } },
    { tokens: [1, STOP], content: 'healed' },
  ],
  tools: new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]),
  policy,
  orchestrate,
  instrument: (ctx: { mockMultimodalError?: () => { message: string; rc: number; partial: boolean } }) => {
    ctx.mockMultimodalError = () => ({ message: 'compute failed', rc: -3, partial: false });
  },
});

describe('scenario: a heal reproduces the original prefix or stands down', () => {
  it('forks the original parent at the original fork point when it is still there', async () => {
    const { held, orchestrate } = withParent();
    const run = await runPool(spec(orchestrate));
    expect(mediaFailures(run.channelEvents), 'the image prefill must have been poisoned').toHaveLength(1);
    expect(run.error, `the pool threw: ${String((run.error as Error)?.message ?? run.error)}`).toBeUndefined();
    const original = (mediaFailures(run.channelEvents)[0] as { agentId: number }).agentId;
    const heals = run.traceEvents.filter(e => e.type === 'pool:agentHeal') as { of: number; agentId: number }[];
    expect(heals.map(h => h.of)).toEqual([original]);
    const P = held.P!;
    const spawns = run.traceEvents.filter(e => e.type === 'agent:spawn') as { agentId: number; parentAgentId: number }[];
    const originalSpawn = spawns.find(s => s.agentId === original)!;
    const replacementSpawn = spawns.find(s => s.agentId === heals[0].agentId)!;
    expect(originalSpawn.parentAgentId).toBe(P.handle);
    expect(replacementSpawn.parentAgentId, 'the replacement forked somewhere other than the original parent').toBe(P.handle);
    // P is the orchestrator's own branch: released here so the leak check sees the pool's work alone.
    P.pruneSync();
    expect(formatResult('I42', I42_noLeakedBranches(run))).toBe('I42: ok');
  });

  it('stands down when the parent has moved since the fork: the failure stands, no heal, no fork', async () => {
    const { held, orchestrate } = withParent(function* (P) {
      yield* waitUntilSettled(P.prefill([9, 9, 9]));   // the prefix the original forked from no longer exists
    });
    const run = await runPool(spec(orchestrate));
    expect(mediaFailures(run.channelEvents), 'the image prefill must have been poisoned').toHaveLength(1);
    expect(run.error, `the pool threw: ${String((run.error as Error)?.message ?? run.error)}`).toBeUndefined();
    expect(run.traceEvents.some(e => e.type === 'pool:agentHeal'), 'a heal was reported onto a prefix the original never had').toBe(false);
    expect(run.traceEvents.some(e => e.type === 'pool:close'), 'the run was torn down, not completed').toBe(true);
    const spawns = run.traceEvents.filter(e => e.type === 'agent:spawn');
    expect(spawns, 'a second fork was announced').toHaveLength(1);
    held.P!.pruneSync();
    expect(formatResult('I42', I42_noLeakedBranches(run))).toBe('I42: ok');
  });

  it('stands down when the parent moves WHILE the replay is being priced: the check sits at the fork, not before the pricing', async () => {
    // A media-bearing lineage is priced through a native call, and the loop
    // fiber suspends on it. Whoever owns an explicit parent can advance it in
    // that window; a check that passed before the pricing would then let the
    // forge fork the moved branch. Two image calls, the second poisoned, so the
    // lineage carries one priced image; the mock holds that pricing while a
    // mover fiber advances `P`. The original is given a live child at the poison
    // so it is not reclaimed before its heal is priced (the orchestrator keeps
    // waiting on it, and the pool stays open for the heal); the mover releases
    // that child once P has moved.
    const pricing = deferred();
    const moved = deferred();
    let heldPricing = false;
    let child = -1;
    const held: { P: Branch | null; ctx: { _branchPrune(h: number): void } | null } = { P: null, ctx: null };
    const orchestrate = function* (ctx: PoolContext): Operation<void> {
      const P = ctx.spine.forkSync();
      held.P = P;
      yield* waitUntilSettled(P.prefill([7, 7, 7, 7, 7, 7, 7, 7]));
      const mover = yield* spawn(function* () {
        yield* until(pricing.promise);
        yield* waitUntilSettled(P.prefill([9, 9, 9]));   // the prefix the original forked from is gone
        held.ctx!._branchPrune(child);                    // the original may be reclaimed now
        moved.resolve();
      });
      const a = yield* ctx.spawn({ content: 'Task 0', systemPrompt: 'You are an agent.', seed: 0, parent: P });
      yield* ctx.waitFor(a);
      yield* mover;
    };
    const run = await runPool({
      nCtx: MEDIA_TEST_NCTX, cellsUsed: 0,
      captureError: true,
      // Fork order: P, the original, the original's held child (never samples), the replacement.
      scripts: [
        { tokens: [STOP] },
        { tokens: [1, STOP], toolCall: { name: 'rasterize', arguments: '{}' } },   // rasterize every turn: the second is poisoned
        { tokens: [STOP] },
        { tokens: [1, STOP], content: 'healed' },
      ],
      tools: new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]),
      policy,
      orchestrate,
      instrument: (ctx) => {
        held.ctx = ctx;
        let images = 0;
        let poisoned = false;
        const innerMM = ctx._storePrefillMultimodal.bind(ctx);
        ctx._storePrefillMultimodal = async (handles, sep, prompts, bitmaps) => {
          const n = ++images;
          if (n === 2) {
            poisoned = true;
            ctx.mockMultimodalError = () => ({ message: 'compute failed', rc: -3, partial: false });
            child = ctx._branchFork(handles[0]);   // a live child: the original waits for its heal
          }
          const out = innerMM(handles, sep, prompts, bitmaps);
          // The poison is the second call's alone: a replacement's replay of the
          // first image must land, or no heal could ever be reported here.
          if (n === 2) out.then(() => {}, () => {}).then(() => { delete (ctx as { mockMultimodalError?: unknown }).mockMultimodalError; });
          return out;
        };
        const innerCells = ctx._cellsMultimodal.bind(ctx);
        ctx._cellsMultimodal = async (sep, prompt, bitmaps) => {
          // The first pricing after the poison is the heal's: hold it until P has moved.
          if (poisoned && !heldPricing) {
            heldPricing = true;
            pricing.resolve();
            await moved.promise;
          }
          return innerCells(sep, prompt, bitmaps);
        };
      },
    });
    expect(heldPricing, 'the heal\'s pricing was never held — the scenario did not exercise the window').toBe(true);
    expect(mediaFailures(run.channelEvents), 'the second image prefill must have been poisoned').toHaveLength(1);
    expect(run.error, `the pool threw: ${String((run.error as Error)?.message ?? run.error)}`).toBeUndefined();
    expect(run.traceEvents.some(e => e.type === 'pool:agentHeal'), 'a heal was forked from a parent that moved during pricing').toBe(false);
    expect(run.traceEvents.filter(e => e.type === 'agent:spawn'), 'a second fork was announced').toHaveLength(1);
    held.P!.pruneSync();
    expect(formatResult('I42', I42_noLeakedBranches(run))).toBe('I42: ok');
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
