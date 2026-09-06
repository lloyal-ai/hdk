/**
 * Scenario: the close never leaves reclaimable KV behind.
 *
 * The close condition says that anything still owed a prune is a branch with
 * live children, which the close cannot free. That assumed the prune pass was
 * complete when the close was decided; it was not. A forward pass skipped a
 * prune-requested parent for its live child, pruned the child later in the
 * same pass, and the close was decided that tick — the now-leaf parent stayed
 * resident, its lease held, until the pool's scope was torn down.
 *
 * What this locks: the pass runs to a fixpoint, so a parent unpinned by its
 * own pass is reclaimed in that observe and its prune is recorded before
 * `pool:close`, not by teardown after it.
 */
import { describe, it, expect } from 'vitest';
import type { Operation } from 'effection';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import type { PoolContext } from '../../../src/orchestrators';
import { runPool, STOP } from '../harness';

const policy: AgentPolicy = {
  onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
  shouldExit: () => false,
  onRecovery: () => ({ type: 'skip' }),
};

describe('scenario: the prune pass completes before the close', () => {
  it('a parent unpinned by its own pass is pruned before pool:close', async () => {
    const orchestrate = function* (ctx: PoolContext): Operation<void> {
      const p = yield* ctx.spawn({ content: 'P', systemPrompt: 'You are an agent.', seed: 0 });
      const c = yield* ctx.spawn({ content: 'C', systemPrompt: 'You are an agent.', seed: 1, parent: p.branch });
      yield* ctx.waitFor(p); yield* ctx.waitFor(c);
    };
    const run = await runPool({
      nCtx: 4096, cellsUsed: 0,
      scripts: [{ tokens: [1, STOP] }, { tokens: [1, 1, STOP] }],   // P idles first; C a tick later
      policy,
      orchestrate,
    });
    const [p, c] = run.result.agents.map(x => x.agentId);
    const types = run.traceEvents.map(e => e.type);
    const close = types.indexOf('pool:close');
    const prunes = run.traceEvents.map((e, i) => [e as { type: string; branchHandle?: number }, i] as const).filter(([e]) => e.type === 'branch:prune');
    const iC = prunes.find(([e]) => e.branchHandle === c)![1];
    const iP = prunes.find(([e]) => e.branchHandle === p)![1];
    expect(close).toBeGreaterThanOrEqual(0);
    expect(iC).toBeLessThan(close);
    expect(iP, 'the parent was reclaimed by teardown, after the close').toBeLessThan(close);
    expect(run.result.agents.every(x => x.agent.status === 'disposed')).toBe(true);
  });
});
