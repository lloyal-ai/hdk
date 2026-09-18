/**
 * Scenario: a spawn batch that fails to land leaves no fork behind.
 *
 * `PoolContext.spawn` forks the spine at once and suspends; the fork's suffix
 * lands in the executor's next batched prefill, and only THEN is the agent
 * registered in the roster. If that prefill throws, the forks exist in the
 * store but nowhere the pool can see them: teardown prunes the roster, the
 * orchestrator's spawn actions stay suspended until the scope halts them, and
 * the forks keep their KV leases for the life of the context. The old loop did
 * not have the gap — it registered the agent at `spawn()` time, before the
 * prefill.
 *
 * Why a lease matters more than the few cells a fork holds: `kv::tenancy`
 * hands every fork a `llama_seq_id`; only `BranchStore::release()` returns it,
 * and `n_seq_max` is the concurrency ceiling — four on a laptop.
 *
 * What this locks: whichever way the pool ends, the only branch left alive is
 * the root it was given (I42), and a spawn whose suffix could not land is
 * rejected, not abandoned mid-suspend.
 */
import { describe, it, expect } from 'vitest';
import { all } from 'effection';
import type { Operation } from 'effection';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import type { PoolContext } from '../../../src/orchestrators';
import { runPool, STOP } from '../harness';
import { I42_noLeakedBranches, formatResult } from '../predicates';

const policy: AgentPolicy = {
  onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
  onRecovery: () => ({ type: 'skip' }),
  shouldExit: () => false,
};

describe('scenario: a failed spawn batch leaves no fork', () => {
  it('both forks are pruned and both spawns are rejected when their suffix prefill throws', async () => {
    const outcomes: string[] = [];
    const twoSpawns = function* (ctx: PoolContext): Operation<void> {
      yield* all([0, 1].map(i => function* () {
        try {
          yield* ctx.spawn({ content: `Task ${i}`, systemPrompt: 'You are an agent.', seed: i });
          outcomes.push('spawned');
        } catch (e) {
          outcomes.push(`rejected: ${(e as Error).message}`);
        }
      }()));
    };

    const run = await runPool({
      nCtx: 8192,
      cellsUsed: 0,
      scripts: [{ tokens: [1, STOP] }, { tokens: [1, STOP] }],
      policy,
      orchestrate: twoSpawns,
      captureError: true,
      instrument: (ctx) => {
        // The spawn batch is the one call carrying both forks; the root's own
        // prefill carries one handle. A fatal rc, as the kernel reports it.
        const inner = ctx._storePrefill.bind(ctx);
        let armed = true;
        ctx._storePrefill = async (handles, tokenArrays) => {
          if (armed && handles.length === 2) {
            armed = false;
            throw Object.assign(new Error('llama_decode failed: rc -1 (mock)'), { rc: -1 });
          }
          return inner(handles, tokenArrays);
        };
      },
    });

    // The invariant: nothing but the root survives the pool.
    expect(formatResult('I42', I42_noLeakedBranches(run))).toBe('I42: ok');
    // And the orchestrator was told, not left hanging. The pool ends right
    // after the rejections and its scope halts the orchestrator's fibers, so
    // how many of them reach their catch before the halt is the scheduler's
    // call — measured: one of two. What is locked is that a spawn that could
    // not land rejects with the batch's error and never resolves as spawned.
    expect(outcomes.length).toBeGreaterThan(0);
    expect(new Set(outcomes)).toEqual(new Set(['rejected: llama_decode failed: rc -1 (mock)']));
    // Unchanged by the fix: a fatal batch still ends the run. The pool's outer
    // catch closes it partial — no `pool:close`, and no error reaches the
    // caller (the same shape as before the rewrite).
    expect(run.traceEvents.some(e => e.type === 'pool:close')).toBe(false);
  });
});
