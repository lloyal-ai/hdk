/**
 * Scenario: a commit batch that fails for room costs the agents in it, not the pool.
 *
 * The generation step is one batched decode of every sampled token. When that
 * decode returns rc 1 with nothing partial, every branch in the batch is intact
 * (the native rollback restores sampler, grammar, metrics and revision), so the
 * failure is recoverable: someone has to give way. Every agent in the failing
 * batch gives way through the ladder's
 * terminal path, `failSettled(a, 'commit_failed', …)`, pruned and announced, its
 * partial report never an outcome; the other agents, the orchestrator and later
 * stages go on, and the pool closes whole. A fatal rc (2, below -1, or none)
 * still closes the pool partial, as it always did.
 *
 * The batch is `S.decode` minus the agents that sampled a stop token this tick.
 */
import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP, chain } from '../harness';
import type { InstrumentedMockSessionContext } from '../harness';

/** The sentinel token whose commit the mock refuses. */
const NO_ROOM = 777;

/** Accept each agent's prose as its result when it stops. */
const policy: AgentPolicy = {
  onProduced: (_a, parsed) => ({ type: 'free_text_return', content: parsed.content ?? '' }),
  shouldExit: () => false,
};

/** The mock refuses a commit carrying the sentinel with the given rc; every other commit lands. */
const refuseCommitsCarrying = (token: number, rc: number) =>
  (ctx: InstrumentedMockSessionContext) => {
    ctx.mockCommitError = (_handles, tokens) =>
      tokens.includes(token) ? { message: 'llama_decode failed: no KV slot', rc, partial: false } : null;
  };

describe('scenario: a commit batch that fails for room gives way', () => {
  it('rc 1: the batch agents fail as commit_failed and are pruned; the sibling that had stopped keeps its result; the pool closes whole', async () => {
    // Agents 0 and 1 sample 1, 2, then the sentinel together; agent 2 stops a tick earlier with its answer.
    const run = await runPool({
      nCtx: 8192, cellsUsed: 0,
      scripts: [
        { tokens: [1, 2, NO_ROOM] },
        { tokens: [1, 2, NO_ROOM] },
        { tokens: [1, STOP], content: 'done' },
      ],
      policy,
      instrument: refuseCommitsCarrying(NO_ROOM, 1),
    });

    expect(run.error, 'the pool run threw instead of closing').toBeUndefined();
    expect(run.result.failure, 'the pool closed partial on a recoverable commit failure').toBeNull();

    const failed = run.channelEvents.filter((e): e is Extract<typeof e, { type: 'agent:failed' }> => e.type === 'agent:failed');
    expect(failed.map(e => e.reason)).toEqual(['commit_failed', 'commit_failed']);
    expect(new Set(failed.map(e => e.agentId)).size, 'each batch agent fails once').toBe(2);

    const settled = run.traceEvents.filter((e): e is Extract<typeof e, { type: 'pool:settleFailed' }> => e.type === 'pool:settleFailed');
    expect(settled.map(e => [e.reason, e.rc])).toEqual([['commit_failed', 1], ['commit_failed', 1]]);

    // Two commits landed (tokens 1 and 2); the third never did, so no tick records it.
    expect(run.traceEvents.filter(e => e.type === 'pool:tick')).toHaveLength(2);
    // Closed whole: the close record is written only on the normal path.
    expect(run.traceEvents.some(e => e.type === 'pool:close')).toBe(true);

    // One outcome per spawn: the two that gave way carry no result, the third its answer.
    const outcomes = run.result.outcomes.map(o => ({ result: o.result, failed: o.failed }));
    expect(outcomes).toEqual([
      { result: null, failed: 'commit_failed' },
      { result: null, failed: 'commit_failed' },
      { result: 'done', failed: null },
    ]);
    // The partial text the two had produced is not an outcome, and their branches were pruned.
    const pruned = run.traceEvents.filter((e): e is Extract<typeof e, { type: 'branch:prune' }> => e.type === 'branch:prune');
    const failedIds = new Set(failed.map(e => e.agentId));
    expect(pruned.filter(p => failedIds.has(p.branchHandle))).toHaveLength(2);
  });

  it('rc 1 in a chain: stage 1 gives way, contributes nothing to the spine, and stage 2 runs', async () => {
    const run = await runPool({
      nCtx: 8192, cellsUsed: 0,
      scripts: [
        { tokens: [1, NO_ROOM] },
        { tokens: [1, STOP], content: 'second' },
      ],
      orchestrate: chain([0, 1], (i) => ({
        task: { content: `Task ${i}`, systemPrompt: 'You are an agent.', seed: i },
        userContent: `Task ${i}`,
      })),
      policy,
      instrument: refuseCommitsCarrying(NO_ROOM, 1),
    });

    expect(run.error).toBeUndefined();
    expect(run.result.failure).toBeNull();
    const extended = run.traceEvents
      .filter((e): e is Extract<typeof e, { type: 'spine:extend' }> => e.type === 'spine:extend')
      .map(e => e.assistantContent);
    expect(extended, 'only the stage that reported extends the spine').toEqual(['second']);
    expect(run.result.outcomes.map(o => o.failed)).toEqual(['commit_failed', null]);
    expect(run.result.outcomes[1].result).toBe('second');
  });

  it('rc 2 still closes the pool partial, with the failure named', async () => {
    const run = await runPool({
      nCtx: 8192, cellsUsed: 0,
      scripts: [{ tokens: [1, NO_ROOM] }, { tokens: [1, NO_ROOM] }],
      policy,
      instrument: refuseCommitsCarrying(NO_ROOM, 2),
    });

    expect(run.result.failure?.message).toMatch(/no KV slot/);
    expect(run.channelEvents.some(e => e.type === 'agent:failed' && e.reason === 'commit_failed')).toBe(false);
    expect(run.traceEvents.some(e => e.type === 'pool:close'), 'a fatal rc closes partial: no close record').toBe(false);
  });

  it('a fatal commit rethrows the store\'s own error: its type and identity reach the failure', async () => {
    // No rc at all: the ladder calls it fatal, and what reaches the pool's failure must be the very error the
    // store threw, not a reading of it, so a caller can tell a TypeError from a decode refusal.
    const thrown = Object.assign(new TypeError('a type error from the store at commit'), { diagnostic: 'kept' });
    const run = await runPool({
      nCtx: 8192, cellsUsed: 0,
      scripts: [{ tokens: [1, NO_ROOM] }, { tokens: [1, NO_ROOM] }],
      policy,
      instrument: (ctx) => {
        const inner = ctx._storeCommit.bind(ctx);
        ctx._storeCommit = async (handles, tokens) => {
          if (tokens.includes(NO_ROOM)) throw thrown;
          return inner(handles, tokens);
        };
      },
    });

    expect(run.result.failure).toBe(thrown);
    expect(run.result.failure).toBeInstanceOf(TypeError);
  });
});
