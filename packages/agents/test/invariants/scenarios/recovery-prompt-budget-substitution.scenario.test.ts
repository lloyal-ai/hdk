/**
 * Scenario: the recovery prompt is handed the live word budget.
 *
 * The policy never renders an app's prompt. At `onRecovery` it computes the
 * one fact it alone knows — the words the report may run to,
 *   `budget = tokenBudgetAsWords(max(50, pressure.remaining - RECOVERY_PROMPT_OVERHEAD - BATCH_BUFFER))`
 * (or the in-loop override) — and calls the app's `PromptOf<{ budget }>` with it.
 *
 * What this locks:
 *   - `DefaultAgentPolicy.onRecovery` calls the prompt function exactly once
 *     with `{ budget }` and returns what it answers, untouched.
 *   - The budget is the pressure-derived figure, or the override when given.
 */
import { describe, it, expect } from 'vitest';
import { DefaultAgentPolicy, ContextPressure } from '../../../src/index';
import type { PromptOf } from '../../../src/index';

// Build a pressure snapshot via the real class, without running a pool.
// onRecovery is a pure policy method — easier to test directly than
// threading through the full pool/harness machinery.
function mkPressure(remaining: number): ContextPressure {
  return new ContextPressure(
    {
      _storeKvPressure: () => ({ nCtx: 16384, cellsUsed: 16384 - remaining, remaining }),
    } as any,
    { softLimit: 1024, hardLimit: 128 },
  );
}

/** A prompt that records every set of facts it was asked with. */
function recording(): { prompt: PromptOf<{ budget: number }>; askedWith: { budget: number }[] } {
  const askedWith: { budget: number }[] = [];
  const prompt: PromptOf<{ budget: number }> = (facts) => {
    askedWith.push(facts);
    return { systemPrompt: `You have ${facts.budget} words to report.`, content: `Report within ${facts.budget}.` };
  };
  return { prompt, askedWith };
}

describe('scenario: recovery prompt budget substitution', () => {
  it('calls the prompt with the computed word budget and returns its text', () => {
    const { prompt, askedWith } = recording();
    const policy = new DefaultAgentPolicy({
      terminalToolName: 'report',
      recovery: { prompt, minTokens: 0, minToolCalls: 0 },
    });

    const agent: any = { tokenCount: 200, toolCallCount: 5 };

    // pressure(remaining=2000) → budgetTokens = max(50, 2000-150-512) = 1338
    // → words = floor(1338 * 0.7 / 10) * 10 = floor(93.66) * 10 = 930
    const action = policy.onRecovery(agent, mkPressure(2000));
    expect(askedWith).toEqual([{ budget: 930 }]);
    expect(action).toEqual({
      type: 'extract',
      prompt: { systemPrompt: 'You have 930 words to report.', content: 'Report within 930.' },
    });
  });

  it('floors the word budget at 10 for pathologically low remaining', () => {
    const { prompt, askedWith } = recording();
    const policy = new DefaultAgentPolicy({
      terminalToolName: 'report',
      recovery: { prompt, minTokens: 0, minToolCalls: 0 },
    });

    const agent: any = { tokenCount: 200, toolCallCount: 5 };

    // remaining=100 → budgetTokens = max(50, 100-150-512) = 50
    // → words = max(10, floor(50 * 0.7 / 10) * 10) = max(10, 30) = 30
    policy.onRecovery(agent, mkPressure(100));
    expect(askedWith).toEqual([{ budget: 30 }]);
  });

  it('hands over the budgetTokens override (the fold path), not the pressure-derived budget', () => {
    const { prompt, askedWith } = recording();
    const policy = new DefaultAgentPolicy({
      terminalToolName: 'report',
      recovery: { prompt, minTokens: 0, minToolCalls: 0 },
    });

    const agent: any = { tokenCount: 200, toolCallCount: 5 };

    // The parallel fold passes its fixed per-recovery budget `b` as onRecovery's 3rd
    // arg so the prompt advisory matches the grammar maxLength cap. b=200 →
    // words = floor(200 * 0.7 / 10) * 10 = 140 (NOT the pressure-derived ~5130).
    policy.onRecovery(agent, mkPressure(8000), 200);
    expect(askedWith).toEqual([{ budget: 140 }]);

    // At the SAME pressure the pressure-derived budget is far larger — proving the
    // override took effect. Without it the model is told to write ~5000 words while
    // the grammar caps it at ~140: exactly the over-generation the override fixes.
    policy.onRecovery(agent, mkPressure(8000));
    expect(askedWith[1].budget).toBeGreaterThan(140);
  });

  it('a skipped recovery never asks the prompt', () => {
    const { prompt, askedWith } = recording();
    const policy = new DefaultAgentPolicy({ terminalToolName: 'report', recovery: { prompt, minToolCalls: 2 } });
    expect(policy.onRecovery({ tokenCount: 200, toolCallCount: 1 } as any, mkPressure(2000))).toEqual({ type: 'skip' });
    expect(askedWith).toEqual([]);
  });
});
