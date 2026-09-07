/**
 * The delegate's two gates, exercised through the tool with a scorer whose
 * numbers are what the real one returns: LOGITS. Measured on Qwen3-Reranker
 * (q8_0, 2026-09-07) against the parent task "speculative decoding on Apple
 * Silicon": paraphrases scored +8.4 to +10.0, a specific sub-question −8 to
 * −9, unrelated text −10 to −11, and one broad sub-question +6.3.
 *
 * @category Testing
 */
import { describe, it, expect, vi } from 'vitest';
import { run } from 'effection';

const seen = vi.hoisted(() => ({ poolOpts: [] as Record<string, unknown>[] }));
vi.mock('@lloyal-labs/lloyal-agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lloyal-labs/lloyal-agents')>();
  return {
    ...actual,
    agentPool: vi.fn(function* (opts: Record<string, unknown>) {
      seen.poolOpts.push(opts);
      return { agents: [], totalTokens: 0, totalToolCalls: 0 };
    }),
  };
});

import { Trace, NullTraceWriter, CallingAgent, Source } from '@lloyal-labs/lloyal-agents';
import type { Agent, ToolContext, ScorerReranker } from '@lloyal-labs/lloyal-agents';
import { DelegateTool } from '../src/tools/delegate';

const ORIGINAL = 'How does speculative decoding perform on Apple Silicon?';
const TASK = 'speculative decoding on Apple Silicon';

/** A reranker that speaks logits: a table of (query → text → score), −9 elsewhere. */
function logitReranker(table: Record<string, Record<string, number>>): ScorerReranker {
  return { scoreBatch: async (query: string, texts: string[]) => texts.map((t) => table[query]?.[t] ?? -9) };
}
class TestSource extends Source {
  readonly name = 'test';
  get tools() { return []; }
  constructor(reranker: ScorerReranker) { super(); this._reranker = reranker; }
}
// The echo guard runs only at depth 2+ (the caller has a parent): sub-questions
// of a harness-spawned agent are expected to resemble its task.
const grandparent = { id: 1, task: 'survey inference runtimes on Apple Silicon', parent: undefined } as unknown as Agent;
const callingAgent = {
  id: 7, task: TASK, parent: grandparent,
  walkAncestors: <T,>(fn: (a: Agent) => readonly T[]) => [...fn({ id: 7, task: TASK } as unknown as Agent), ...fn(grandparent)],
} as unknown as Agent;

type Out = { results?: unknown[]; filtered?: { task: string; score: number }[]; echoRejected?: boolean; error?: string };
function delegate(reranker: ScorerReranker, tasks: string[]): Promise<Out> {
  const tool = new DelegateTool({ poolOpts: {}, systemPrompt: 'sys', extractTasks: (a) => a.tasks as string[] });
  const scorer = new TestSource(reranker).createScorer(ORIGINAL);
  return run(function* () {
    yield* Trace.set(new NullTraceWriter());
    yield* CallingAgent.set(callingAgent);
    return (yield* tool.execute({ tasks }, { agentId: 7, scorer, attachments: [] } as unknown as ToolContext)) as Out;
  });
}

describe('delegate gates, in logits', () => {
  it('the entailment gate keeps a task the original question entails and filters one it does not', async () => {
    const kept = 'draft model architecture trade-offs for speculative decoding';
    const dropped = 'history of the Ottoman navy in the sixteenth century';
    const r = await delegate(logitReranker({ [ORIGINAL]: { [kept]: 4, [dropped]: -8 }, [TASK]: { [kept]: -2, [dropped]: -9 } }), [kept, dropped]);
    expect(r.error).toBeUndefined();
    expect(r.filtered?.map((f) => f.task)).toEqual([dropped]);
    expect(seen.poolOpts.at(-1)?.orchestrate).toBeTruthy();
  });

  it('paraphrases of the caller\'s own task are an echo: nothing is spawned', async () => {
    const p1 = 'speculative decoding performance on M1, M2 and M3';
    const p2 = 'benchmarks for speculative decoding on Apple Silicon';
    const before = seen.poolOpts.length;
    const r = await delegate(logitReranker({ [ORIGINAL]: { [p1]: 5, [p2]: 5 }, [TASK]: { [p1]: 8.7, [p2]: 10 } }), [p1, p2]);
    expect(r.echoRejected).toBe(true);
    expect(seen.poolOpts.length).toBe(before);
  });

  it('related but distinct sub-questions are NOT an echo — a 0–1 threshold read against logits would reject them', async () => {
    const s1 = 'how the M3 Max memory bandwidth limits token throughput';
    const s2 = 'acceptance rate of draft tokens in llama.cpp';
    const before = seen.poolOpts.length;
    // Similar enough to the parent to score positive, far from paraphrase: +3 each.
    const r = await delegate(logitReranker({ [ORIGINAL]: { [s1]: 4, [s2]: 4 }, [TASK]: { [s1]: 3, [s2]: 3 } }), [s1, s2]);
    expect(r.echoRejected).toBeUndefined();
    expect(r.error).toBeUndefined();
    expect(seen.poolOpts.length).toBe(before + 1);
  });
});
