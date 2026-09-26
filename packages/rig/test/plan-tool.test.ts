/**
 * The plan tool's parent, and the single-task plan beside it.
 *
 * `singleTaskPlan(text)` is the plan an ask is: one task, the question itself,
 * no planner. `PlanTool` forks its planning agent from `parent` when one is
 * given, else from the session's trunk — the caller says where the plan reads
 * from, and a caller with a branch in hand need not hold a Session.
 */
import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import { initAgents } from '@lloyal-labs/lloyal-agents';
import { Branch } from '@lloyal-labs/sdk';
import { MockSessionContext } from '@lloyal-labs/sdk/dist/testing.js';
import type { SessionContext } from '@lloyal-labs/sdk';
import { PlanTool, singleTaskPlan } from '../src/tools/plan';

describe('singleTaskPlan', () => {
  it('is one research task, the text itself, with nothing to clarify', () => {
    expect(singleTaskPlan('What is X?')).toEqual({
      intent: 'research',
      tasks: [{ description: 'What is X?' }],
      clarifyQuestions: [],
      tokenCount: 0,
      timeMs: 0,
    });
  });
});

describe('PlanTool.parent', () => {
  it('plans on a fork of the given parent, with no Session in hand', async () => {
    const mock = new MockSessionContext();
    const forkedFrom: number[] = [];
    const inner = mock._branchFork.bind(mock);
    mock._branchFork = (parentHandle: number) => { forkedFrom.push(parentHandle); return inner(parentHandle); };
    const ctx = mock as unknown as SessionContext;

    await run(function* () {
      yield* initAgents(ctx);
      const parent = Branch.create(ctx, 0);
      const tool = new PlanTool({ prompt: ({ query }) => ({ systemPrompt: 'plan', content: query }), parent, maxTasks: 3 });
      const plan = yield* tool.execute({ query: 'anything' });
      expect(plan).toHaveProperty('intent');
    });
    expect(forkedFrom[0]).toBeDefined();
    expect(forkedFrom[0]).toBe(1); // the first branch created is the parent; the planning root forks from it
  });
});
