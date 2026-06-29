/**
 * Scenario: recovery prompt renders `<%= it.budget %>` with the live budget.
 *
 * When the policy's recovery prompt contains eta tags, they are rendered
 * at `onRecovery` call time with a context containing the computed budget:
 *   `budget = max(50, pressure.remaining - RECOVERY_PREFILL_OVERHEAD - BATCH_BUFFER)`.
 *
 * What this locks:
 *   - `DefaultAgentPolicy.onRecovery` invokes eta templating on both the
 *     system and user strings.
 *   - The rendered strings contain the numeric budget (no `<%= %>` tags
 *     leak through — they get substituted).
 */
import { describe, it, expect } from 'vitest';
import { DefaultAgentPolicy, ContextPressure } from '../../../src/index';

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

describe('scenario: recovery prompt budget substitution', () => {
  it('renders <%= it.budget %> with the computed word budget', () => {
    const policy = new DefaultAgentPolicy({
      terminalToolName: 'report',
      recovery: {
        prompt: {
          system: 'You have <%= it.budget %> words to report.',
          user: 'Report within <%= it.budget %>.',
        },
        minTokens: 0,
        minToolCalls: 0,
      },
    });

    const agent: any = { tokenCount: 200, toolCallCount: 5 };

    // pressure(remaining=2000) → budgetTokens = max(50, 2000-150-512) = 1338
    // → words = floor(1338 * 0.7 / 10) * 10 = floor(93.66) * 10 = 930
    const action = policy.onRecovery(agent, mkPressure(2000));
    expect(action.type).toBe('extract');
    const extract = action as { type: 'extract'; prompt: { system: string; user: string } };
    expect(extract.prompt.system).toBe('You have 930 words to report.');
    expect(extract.prompt.user).toBe('Report within 930.');

    // No eta tags survive in the output.
    expect(extract.prompt.system).not.toContain('<%=');
    expect(extract.prompt.user).not.toContain('<%=');
  });

  it('floors the word budget at 10 for pathologically low remaining', () => {
    const policy = new DefaultAgentPolicy({
      terminalToolName: 'report',
      recovery: {
        prompt: {
          system: 'Budget: <%= it.budget %>',
          user: 'Report.',
        },
        minTokens: 0,
        minToolCalls: 0,
      },
    });

    const agent: any = { tokenCount: 200, toolCallCount: 5 };

    // remaining=100 → budgetTokens = max(50, 100-150-512) = 50
    // → words = max(10, floor(50 * 0.7 / 10) * 10) = max(10, 30) = 30
    const action = policy.onRecovery(agent, mkPressure(100));
    const extract = action as { type: 'extract'; prompt: { system: string; user: string } };
    expect(extract.prompt.system).toBe('Budget: 30');
  });

  it('renders the budgetTokens override (the fold path), not the pressure-derived budget', () => {
    const policy = new DefaultAgentPolicy({
      terminalToolName: 'report',
      recovery: {
        prompt: {
          system: 'You have <%= it.budget %> words to report.',
          user: 'Report.',
        },
        minTokens: 0,
        minToolCalls: 0,
      },
    });

    const agent: any = { tokenCount: 200, toolCallCount: 5 };

    // The parallel fold passes its fixed per-report budget `b` as onRecovery's 3rd
    // arg so the prompt advisory matches the grammar maxLength cap. b=200 →
    // words = floor(200 * 0.7 / 10) * 10 = 140 (NOT the pressure-derived ~5130).
    const overridden = policy.onRecovery(agent, mkPressure(8000), 200) as
      { type: 'extract'; prompt: { system: string; user: string } };
    expect(overridden.prompt.system).toBe('You have 140 words to report.');

    // At the SAME pressure the pressure-derived budget is far larger — proving the
    // override took effect. Without it the model is told to write ~5000 words while
    // the grammar caps it at ~140: exactly the over-generation the override fixes.
    const pressureDerived = policy.onRecovery(agent, mkPressure(8000)) as
      { type: 'extract'; prompt: { system: string } };
    expect(pressureDerived.prompt.system).not.toBe(overridden.prompt.system);
  });
});
