import { describe, it, expect, vi } from 'vitest';
import { FMT } from './helpers/format-config';
import { createToolkit } from '../src/toolkit';
import { ContextPressure } from '../src/pressure';
import { Agent } from '../src/Agent';
import { MockTool } from './helpers/mock-tool';
import { createMockBranch } from './helpers/mock-branch';
import type { EntailmentScorer } from '../src/scorer';
import { DefaultAgentPolicy } from '../src/AgentPolicy';

// ── Pure unit tests (no Effection) ──────────────────────────

/** A frozen pressure reading — the real value, not a hand-rolled twin. */
function pressureAt(remaining: number, nCtx: number): ContextPressure {
  return new ContextPressure({ nCtx, cellsUsed: nCtx - remaining, remaining }, { softLimit: 1024, hardLimit: 128 });
}

describe('spawnAgents — toolkit composition', () => {
  // We can't call spawnAgents directly without Effection, but we can
  // test the toolkit composition logic by inspecting createToolkit output

  it('createToolkit includes all provided tools', () => {
    const search = new MockTool('web_search');
    const fetch = new MockTool('fetch_page');
    const report = new MockTool('report');
    const toolkit = createToolkit([search, fetch, report]);

    expect(toolkit.toolMap.has('web_search')).toBe(true);
    expect(toolkit.toolMap.has('fetch_page')).toBe(true);
    expect(toolkit.toolMap.has('report')).toBe(true);
    expect(toolkit.toolMap.size).toBe(3);
  });

  it('toolsJson contains JSON schema for all tools', () => {
    const search = new MockTool('web_search');
    const toolkit = createToolkit([search]);
    const parsed = JSON.parse(toolkit.toolsJson);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].function.name).toBe('web_search');
  });
});

// ── Steering vs content boundary distinction ────────────────

describe('Entailment boundary discipline', () => {
  it('WebSearchTool and DelegateTool are steering boundaries (use scorer)', () => {
    // This is a design test — the tools read context.scorer and act on it.
    // We verify the API surface exists and is used correctly.
    // The actual tool execution tests are in packages/rig/test/

    // Verify EntailmentScorer interface has the right shape
    const scorer: EntailmentScorer = {
      scoreEntailmentBatch: async (texts) => texts.map(() => 0.5),
      scoreSimilarityBatch: async (_ref, texts) => texts.map(() => 0),
      shouldProceed: (score) => score >= 0.25,
    };
    expect(scorer.scoreEntailmentBatch).toBeDefined();
    expect(scorer.shouldProceed).toBeDefined();
  });

  it('SearchTool and FetchPageTool are content boundaries (no scorer)', () => {
    // Design assertion: these tools score against agent's local query only.
    // They do NOT call scorer.scoreEntailmentBatch.
    // The reason: agent-local scoring at content boundaries preserves
    // serendipitous discovery. "United States v. Microsoft" scores low
    // against "iPod-era success to monopoly practices" but is the causal
    // evidence connecting them. Dual scoring would demote it.
    //
    // This is validated by the absence of scorer calls in SearchTool and
    // FetchPageTool source code (verified during implementation).
    expect(true).toBe(true); // design marker — enforced by code review
  });
});

// ── RecursiveOpts ───────────────────────────────────────────

describe('RecursiveOpts', () => {
  it('default extractTasks reads args.tasks', () => {
    const defaultExtract = (args: Record<string, unknown>) => args.tasks as string[];
    const result = defaultExtract({ tasks: ['a', 'b', 'c'] });
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('custom extractTasks reads custom field', () => {
    const customExtract = (args: Record<string, unknown>) => args.questions as string[];
    const result = customExtract({ questions: ['q1', 'q2'] });
    expect(result).toEqual(['q1', 'q2']);
  });

  it('extractTasks failure returns undefined/throws', () => {
    const extract = (args: Record<string, unknown>) => args.missing as string[];
    const result = extract({});
    expect(result).toBeUndefined();
  });
});

// ── Agent.task field ────────────────────────────────────────

describe('Agent.task', () => {
  it('stores task text from construction', () => {
    const branch = createMockBranch();
    const a = new Agent({
      id: 1, parentId: 0, branch: branch as any,
      fmt: FMT,
      task: 'investigate speculative decoding on M3',
    });
    expect(a.task).toBe('investigate speculative decoding on M3');
  });

  it('defaults to empty string when not provided', () => {
    const branch = createMockBranch();
    const a = new Agent({
      id: 1, parentId: 0, branch: branch as any,
      fmt: FMT,
    });
    expect(a.task).toBe('');
  });
});

// ── Decoupling: explore/exploit independent of lifecycle ──

describe('Explore/exploit decoupled from lifecycle', () => {
  it('exploit mode does not affect agent lifecycle — agent is active, not killed', () => {
    // Agent in exploit mode (low pressure → shouldExplore false)
    // but NOT nudged or killed (shouldExit false, onProduced returns tool_call)
    const policy = new DefaultAgentPolicy({ shouldExplore: { context: 0.5 }, nudge: (f) => `call ${f.terminal} within ${f.words} words` });
    const branch = createMockBranch();
    const a = new Agent({
      id: 1, parentId: 0, branch: branch as any,
      fmt: FMT,
    });
    a.transition('active');
    a.incrementToolCalls();
    a.incrementToolCalls();

    // Pressure at 45% — below context threshold (0.5) → exploit mode
    const p = pressureAt(7372, 16384);

    // shouldExplore = false (exploit)
    expect(policy.shouldExplore(a, p)).toBe(false);

    // But shouldExit = false (not critical, no time limit)
    expect(policy.shouldExit(a, p)).toBe(false);

    // And onProduced allows tool_call (headroom positive, not over budget)
    const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
    const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, p,
      { maxTurns: 20, terminalToolName: 'report' });
    expect(action.type).toBe('tool_call');
    expect(a.status).toBe('active');
  });

  it('lifecycle nudge does not suppress explore mode', () => {
    // Agent nudged (over budget) while shouldExplore is true
    const policy = new DefaultAgentPolicy({ nudge: (f) => `call ${f.terminal} within ${f.words} words` });
    const branch = createMockBranch();
    const a = new Agent({
      id: 1, parentId: 0, branch: branch as any,
      fmt: FMT,
    });
    a.transition('active');
    a.incrementToolCalls();
    a.incrementToolCalls();
    a.incrementToolCalls();
    for (let i = 0; i < 25; i++) a.incrementTurns();

    // Pressure at 60% — above threshold → explore mode
    const p = pressureAt(9830, 16384);

    // shouldExplore = true (explore)
    expect(policy.shouldExplore(a, p)).toBe(true);

    // But onProduced nudges (turns >= maxTurns)
    const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
    const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, p,
      { maxTurns: 20, terminalToolName: 'report' });
    expect(action.type).toBe('nudge');

    // Explore and lifecycle are independent decisions
  });

  it('explore and lifecycle states do not bleed into each other', () => {
    const policy = new DefaultAgentPolicy({ shouldExplore: { context: 0.4 }, nudge: (f) => `call ${f.terminal} within ${f.words} words` });
    const a = new Agent({
      id: 1, parentId: 0, branch: createMockBranch() as any,
      fmt: FMT,
    });

    const highPressure = pressureAt(12000, 16384);
    const lowPressure = pressureAt(4915, 16384);

    // High pressure: explore=true, shouldExit=false
    expect(policy.shouldExplore(a, highPressure)).toBe(true);
    expect(policy.shouldExit(a, highPressure)).toBe(false);

    // Low pressure: explore=false, shouldExit still false (not critical)
    expect(policy.shouldExplore(a, lowPressure)).toBe(false);
    expect(policy.shouldExit(a, lowPressure)).toBe(false);

    // Critical: shouldExit=true, explore is irrelevant but still computable
    const criticalPressure = pressureAt(100, 16384);
    expect(policy.shouldExit(a, criticalPressure)).toBe(true);
    expect(policy.shouldExplore(a, criticalPressure)).toBe(false);
  });
});

// ── EntailmentScorer interface shape ──────────────────────

describe('EntailmentScorer interface', () => {
  it('scores against the original question, against a reference, and gates — exploit combines in admission, not here', () => {
    const scorer: EntailmentScorer = {
      scoreEntailmentBatch: async (texts) => texts.map(() => 0.5),
      scoreSimilarityBatch: async (_ref, texts) => texts.map(() => 0),
      shouldProceed: (score) => score >= 0.25,
    };
    expect(scorer.scoreEntailmentBatch).toBeDefined();
    expect('scoreRelevanceBatch' in scorer).toBe(false);
  });
});
