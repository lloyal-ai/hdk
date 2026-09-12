/**
 * `DefaultAgentPolicy` as a router: what `onProduced` makes of a turn, and the
 * policy's other per-agent answers. Gates are not here — the pool runs them
 * before `onProduced` is called (`hooks.ts`, tested in `hooks.test.ts`), and
 * the policy's own lifecycle entry (its retry budget and settle nudge) is
 * tested there too, through the frame's walk.
 */
import { describe, it, expect } from 'vitest';
import { DefaultAgentPolicy } from '../src/AgentPolicy';
import { ContextPressure } from '../src/pressure';
import type { PolicyConfig } from '../src/AgentPolicy';
import { Agent } from '../src/Agent';
import { createMockBranch } from './helpers/mock-branch';

import { FMT } from './helpers/format-config';

const BASE_CONFIG: PolicyConfig = { maxTurns: 20, terminalToolName: 'report', hasNonTerminalTools: true };

function makeAgent(overrides?: { toolCallCount?: number; turns?: number; toolHistory?: Array<{ name: string; args: string }> }) {
  const branch = createMockBranch();
  const a = new Agent({ id: 1, parentId: 0, branch: branch as any, fmt: FMT });
  a.transition('active');
  for (let i = 0; i < (overrides?.toolCallCount ?? 0); i++) a.incrementToolCalls();
  for (let i = 0; i < (overrides?.turns ?? 0); i++) a.incrementTurns();
  for (const h of overrides?.toolHistory ?? []) {
    a.recordToolResult({ name: h.name, args: h.args, resultCells: 100, contextAfterPercent: 80, timestamp: 0, outcome: 'toolResult' });
  }
  return a;
}

/** A frozen pressure reading — the real value, not a hand-rolled twin. */
function pressure(remaining = 5000, nCtx = 16384): ContextPressure {
  return new ContextPressure({ nCtx, cellsUsed: nCtx - remaining, remaining }, { softLimit: 1024, hardLimit: 128 });
}

describe('DefaultAgentPolicy', () => {
  const policy = new DefaultAgentPolicy();

  describe('onProduced — no tool call', () => {
    it('returns free_text_return when agent has findings-worthy output', () => {
      const a = makeAgent({ toolCallCount: 2 });
      const action = policy.onProduced(a, { content: 'some text', toolCalls: [] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('free_text_return');
    });

    it('returns idle when nothing to capture', () => {
      const a = makeAgent();
      const action = policy.onProduced(a, { content: null, toolCalls: [] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('idle');
    });
  });

  describe('onProduced — terminal tool', () => {
    it('extracts findings from report', () => {
      const a = makeAgent({ toolCallCount: 3 });
      const tc = { name: 'report', arguments: JSON.stringify({ result: 'my result' }), id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action).toEqual({ type: 'return', result: 'my result' });
    });

    it('nudges premature report (< 2 tool calls)', () => {
      const a = makeAgent({ toolCallCount: 1 });
      const tc = { name: 'report', arguments: '{}', id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
    });

    it('allows report when over budget despite < minToolCalls', () => {
      const a = makeAgent({ toolCallCount: 1, turns: 25 });
      const tc = { name: 'report', arguments: JSON.stringify({ result: 'r' }), id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('return');
    });
  });

  describe('onProduced — JSON parse edge cases', () => {
    it('T7: terminal tool with malformed JSON falls back to raw arguments', () => {
      const a = makeAgent({ toolCallCount: 3 });
      const tc = { name: 'report', arguments: 'not valid json', id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action).toEqual({ type: 'return', result: 'not valid json' });
    });

  });

  describe('onProduced — over budget', () => {
    it('nudges every time (stateless, no escalation)', () => {
      const a = makeAgent({ toolCallCount: 3, turns: 25 });
      const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
    });

    it('trailing stop: first over-budget agent nudged, second gets tool_call', () => {
      // Reset trailing stop state by simulating a new tick
      policy.resetTick();
      const a1 = makeAgent({ toolCallCount: 5, turns: 25 });
      const a2 = makeAgent({ toolCallCount: 5, turns: 25 });
      const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
      const action1 = policy.onProduced(a1, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action1.type).toBe('nudge');
      const action2 = policy.onProduced(a2, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action2.type).toBe('tool_call');
    });
  });

  describe('onProduced — an ordinary call', () => {
    it('routes it to dispatch: the gates are the pool\'s, run before this is called', () => {
      const a = makeAgent({ toolCallCount: 0 });
      const tc = { name: 'web_research', arguments: '{"questions":["q"]}', id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action).toEqual({ type: 'tool_call', tc });
    });
  });

  describe('custom opts', () => {
    it('respects custom minToolCallsBeforeReturn', () => {
      const customPolicy = new DefaultAgentPolicy({ minToolCallsBeforeReturn: 5 });
      const a = makeAgent({ toolCallCount: 3 });
      const tc = { name: 'report', arguments: '{"findings":"f"}', id: 'c1' };
      const action = customPolicy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
    });
  });

  describe('shouldExplore', () => {
    it('returns true when percentAvailable > threshold (default 40)', () => {
      // 5000/16384 ≈ 30.5% → false
      expect(policy.shouldExplore(makeAgent(), pressure(5000))).toBe(false);
      // 8000/16384 ≈ 48.8% → true
      expect(policy.shouldExplore(makeAgent(), pressure(8000))).toBe(true);
    });

    it('respects custom shouldExplore.context threshold', () => {
      const lowThreshold = new DefaultAgentPolicy({ shouldExplore: { context: 0.2 } });
      // 30% > 20% → true
      expect(lowThreshold.shouldExplore(makeAgent(), pressure(5000))).toBe(true);

      const highThreshold = new DefaultAgentPolicy({ shouldExplore: { context: 0.7 } });
      // 48% < 70% → false
      expect(highThreshold.shouldExplore(makeAgent(), pressure(8000))).toBe(false);
    });

    it('setExploitMode(true) overrides to always false', () => {
      const p = new DefaultAgentPolicy();
      const highPressure = pressure(15000); // ~91% available
      expect(p.shouldExplore(makeAgent(), highPressure)).toBe(true);

      p.setExploitMode(true);
      expect(p.shouldExplore(makeAgent(), highPressure)).toBe(false);
    });

    it('setExploitMode(false) reverts to pressure-driven', () => {
      const p = new DefaultAgentPolicy();
      p.setExploitMode(true);
      expect(p.shouldExplore(makeAgent(), pressure(15000))).toBe(false);

      p.setExploitMode(false);
      expect(p.shouldExplore(makeAgent(), pressure(15000))).toBe(true);
    });

    it('nCtx=0 → percentAvailable=100 → explore', () => {
      // When nCtx is 0, remaining=Infinity, percentAvailable=100
      const noLimit = pressure(Infinity, 0);
      expect(noLimit.percentAvailable).toBe(100);
      expect(policy.shouldExplore(makeAgent(), noLimit)).toBe(true);
    });

    it('nCtx=0 → canFit always true (Infinity chain)', () => {
      const noLimit = pressure(Infinity, 0);
      expect(noLimit.headroom).toBe(Infinity);
      expect(noLimit.canFit(999999)).toBe(true);
      expect(noLimit.critical).toBe(false);
    });
  });

  describe('shouldExit', () => {
    it('returns false when pressure not critical', () => {
      expect(policy.shouldExit(makeAgent(), pressure(5000))).toBe(false);
    });

    it('returns true when pressure critical', () => {
      expect(policy.shouldExit(makeAgent(), pressure(50))).toBe(true);
    });

    it('no time budget → only pressure checked', () => {
      const p = new DefaultAgentPolicy(); // no budget
      expect(p.shouldExit(makeAgent(), pressure(5000))).toBe(false);
      expect(p.shouldExit(makeAgent(), pressure(50))).toBe(true);
    });

    it('time hardLimit exceeded → returns true', () => {
      const p = new DefaultAgentPolicy({ budget: { time: { hardLimit: 0 } } }); // 0ms = instant
      expect(p.shouldExit(makeAgent(), pressure(5000))).toBe(true);
    });

    it('time hardLimit not exceeded → returns false', () => {
      const p = new DefaultAgentPolicy({ budget: { time: { hardLimit: 999_999 } } });
      expect(p.shouldExit(makeAgent(), pressure(5000))).toBe(false);
    });

    it('pressure OK + time exceeded → exit', () => {
      const p = new DefaultAgentPolicy({ budget: { time: { hardLimit: 0 } } });
      expect(p.shouldExit(makeAgent(), pressure(5000))).toBe(true);
    });

    it('pressure critical + time OK → exit', () => {
      const p = new DefaultAgentPolicy({ budget: { time: { hardLimit: 999_999 } } });
      expect(p.shouldExit(makeAgent(), pressure(50))).toBe(true);
    });
  });

  describe('onRecovery', () => {
    it('returns skip when no recovery config', () => {
      const result = policy.onRecovery!(makeAgent({ toolCallCount: 5 }), pressure());
      expect(result).toEqual({ type: 'skip' });
    });

    it('returns skip when tokenCount < minTokens', () => {
      const p = new DefaultAgentPolicy({ recovery: { prompt: { system: 's', user: 'u' }, minTokens: 200 } });
      const a = makeAgent({ toolCallCount: 5 }); // tokenCount=0 < 200
      expect(p.onRecovery!(a, pressure())).toEqual({ type: 'skip' });
    });

    it('returns skip when toolCallCount < minToolCalls', () => {
      const p = new DefaultAgentPolicy({ recovery: { prompt: { system: 's', user: 'u' }, minToolCalls: 5 } });
      const a = makeAgent({ toolCallCount: 2 }); // 2 < 5
      expect(p.onRecovery!(a, pressure())).toEqual({ type: 'skip' });
    });

    it('returns extract with prompt when guard passes', () => {
      const prompt = { system: 'extract findings', user: 'report now' };
      const p = new DefaultAgentPolicy({ recovery: { prompt } });
      const a = makeAgent({ toolCallCount: 3 });
      // Need tokenCount >= 100 — manually set via accumulating tokens
      for (let i = 0; i < 101; i++) a.accumulateToken('x');
      // Prompt strings contain no eta tags → render returns them unchanged.
      expect(p.onRecovery(a, pressure() as any)).toEqual({ type: 'extract', prompt });
    });

    it('custom minTokens/minToolCalls respected', () => {
      const prompt = { system: 's', user: 'u' };
      const p = new DefaultAgentPolicy({ recovery: { prompt, minTokens: 10, minToolCalls: 1 } });
      const a = makeAgent({ toolCallCount: 1 });
      for (let i = 0; i < 11; i++) a.accumulateToken('x');
      expect(p.onRecovery(a, pressure() as any)).toEqual({ type: 'extract', prompt });
    });

    it('defaults: minTokens=100, minToolCalls=2', () => {
      const prompt = { system: 's', user: 'u' };
      const p = new DefaultAgentPolicy({ recovery: { prompt } });
      // toolCallCount=1 < default 2 → skip
      const a = makeAgent({ toolCallCount: 1 });
      for (let i = 0; i < 101; i++) a.accumulateToken('x');
      expect(p.onRecovery(a, pressure() as any)).toEqual({ type: 'skip' });
    });

    it('renders <%= it.budget %> with the computed word budget', () => {
      const prompt = {
        system: 'Budget: <%= it.budget %> words.',
        user: 'Report within <%= it.budget %>.',
      };
      const p = new DefaultAgentPolicy({ recovery: { prompt } });
      const a = makeAgent({ toolCallCount: 3 });
      for (let i = 0; i < 101; i++) a.accumulateToken('x');
      // pressure(remaining=5000) → budgetTokens = max(50, 5000-150-512) = 4338
      // → words = floor(4338 * 0.7 / 10) * 10 = 3030
      // …but the advisory is capped at 1200: past that, a big number reads
      // as an invitation to pad and repeat toward it.
      const result = p.onRecovery(a, pressure() as any) as { type: 'extract'; prompt: { system: string; user: string } };
      expect(result.type).toBe('extract');
      expect(result.prompt.system).toBe('Budget: 1200 words.');
      expect(result.prompt.user).toBe('Report within 1200.');
    });

    it('renders the exact budget when genuinely below the 1200-word cap', () => {
      const prompt = {
        system: 'Budget: <%= it.budget %> words.',
        user: 'Report within <%= it.budget %>.',
      };
      const p = new DefaultAgentPolicy({ recovery: { prompt } });
      const a = makeAgent({ toolCallCount: 3 });
      for (let i = 0; i < 101; i++) a.accumulateToken('x');
      // budgetTokensOverride 1000 → words = floor(1000 * 0.7 / 10) * 10 = 700 (< cap)
      const result = p.onRecovery(a, pressure() as any, 1000) as { type: 'extract'; prompt: { system: string } };
      expect(result.prompt.system).toBe('Budget: 700 words.');
    });
  });

  describe('budget + pressureThresholds', () => {
    it('no budget → pressureThresholds returns defaults', () => {
      // hardLimit default is 512 (matches llama.cpp's default nBatch —
      // enforced at pool startup via the hardLimit >= nBatch invariant).
      expect(policy.pressureThresholds).toEqual({ softLimit: 1024, hardLimit: 512 });
    });

    it('budget.context.softLimit overrides default', () => {
      const p = new DefaultAgentPolicy({ budget: { context: { softLimit: 2048 } } });
      expect(p.pressureThresholds.softLimit).toBe(2048);
      expect(p.pressureThresholds.hardLimit).toBe(512); // default
    });

    it('budget.context.hardLimit overrides default', () => {
      const p = new DefaultAgentPolicy({ budget: { context: { hardLimit: 1024 } } });
      expect(p.pressureThresholds.hardLimit).toBe(1024);
      expect(p.pressureThresholds.softLimit).toBe(1024); // default
    });

    it('partial budget → other uses default', () => {
      const p = new DefaultAgentPolicy({ budget: { context: { softLimit: 2048 } } });
      expect(p.pressureThresholds).toEqual({ softLimit: 2048, hardLimit: 512 });
    });

    it('pressureThresholds getter returns correct shape', () => {
      const pt = policy.pressureThresholds;
      expect(pt).toHaveProperty('softLimit');
      expect(pt).toHaveProperty('hardLimit');
      expect(typeof pt.softLimit).toBe('number');
      expect(typeof pt.hardLimit).toBe('number');
    });
  });

  describe('time budget in onProduced', () => {
    it('no time budget → overBudget driven by turns/headroom', () => {
      policy.resetTick();
      const a = makeAgent({ toolCallCount: 3, turns: 25 });
      const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
      expect((action as any).message).toContain('Turn limit');
    });

    it('time softLimit exceeded → nudge with time message', () => {
      const p = new DefaultAgentPolicy({ budget: { time: { softLimit: 0 } } }); // 0ms = instant
      const a = makeAgent({ toolCallCount: 3 });
      const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
      const action = p.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
      expect((action as any).message).toContain('Time limit');
    });

    it('time softLimit not exceeded → no time nudge', () => {
      const p = new DefaultAgentPolicy({ budget: { time: { softLimit: 999_999 } } });
      const a = makeAgent({ toolCallCount: 3 });
      const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
      const action = p.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('tool_call');
    });

    it('time nudge message distinct from pressure/turns (includes budget in words)', () => {
      const p = new DefaultAgentPolicy({ budget: { time: { softLimit: 0 } } });
      const a = makeAgent({ toolCallCount: 3 });
      const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
      // pressure(remaining=5000, hardLimit=128) → budgetTokens = 4872
      // → uncapped words would be 3410; the advisory caps at 1200.
      const action = p.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect((action as any).message).toBe('Time limit reached — report your findings now within 1200 words.');
    });
  });

  describe('underPressure / overBudget split', () => {
    it('underPressure + terminal tool → report accepted despite < minToolCalls', () => {
      const a = makeAgent({ toolCallCount: 1, turns: 25 }); // turns >= maxTurns
      const tc = { name: 'report', arguments: JSON.stringify({ result: 'r' }), id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('return');
    });

    it('underPressure (time) + terminal tool → report accepted', () => {
      const p = new DefaultAgentPolicy({ budget: { time: { softLimit: 0 } } });
      const a = makeAgent({ toolCallCount: 1 });
      const tc = { name: 'report', arguments: JSON.stringify({ result: 'r' }), id: 'c1' };
      const action = p.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('return');
    });

    it('not underPressure + terminal tool + < minToolCalls → premature nudge', () => {
      const a = makeAgent({ toolCallCount: 1 });
      const tc = { name: 'report', arguments: '{}', id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
      expect((action as any).message).toContain('must use tools');
    });

    it('underPressure + non-terminal tool → overBudget → nudge (first agent)', () => {
      // Reset trailing stop state by simulating a new tick
      policy.resetTick();
      const a = makeAgent({ toolCallCount: 3, turns: 25 });
      const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
    });
  });

  describe('trailing stop nudge', () => {
    it('nudges first agent, lets subsequent agents tool_call (no escalation)', () => {
      // Reset state
      policy.resetTick();
      const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
      // First agent — nudged
      const a1 = makeAgent({ toolCallCount: 3, turns: 25 });
      const action1 = policy.onProduced(a1, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action1.type).toBe('nudge');
      // Second agent — tool_call (trailing stop, not killed)
      const a2 = makeAgent({ toolCallCount: 3, turns: 25 });
      const action2 = policy.onProduced(a2, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action2.type).toBe('tool_call');
      // Third agent — also tool_call
      const a3 = makeAgent({ toolCallCount: 3, turns: 25 });
      const action3 = policy.onProduced(a3, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action3.type).toBe('tool_call');
    });

    it('headroom recovers → tool_call allowed', () => {
      const a = makeAgent({ toolCallCount: 3, turns: 5 });
      const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
      // Over budget (headroom negative) — first nudge
      policy.resetTick(); // reset
      const lowPressure = pressure(500); // headroom = 500 - 1024 = -524
      const action1 = policy.onProduced(a, { content: null, toolCalls: [tc] }, lowPressure, BASE_CONFIG);
      expect(action1.type).toBe('nudge');
      // Headroom recovers
      const highPressure = pressure(5000); // headroom = 3976
      const action2 = policy.onProduced(a, { content: null, toolCalls: [tc] }, highPressure, BASE_CONFIG);
      expect(action2.type).toBe('tool_call');
    });

    it('no nudged/markNudged in agent API', () => {
      const a = makeAgent();
      expect('nudged' in a).toBe(false);
      expect('markNudged' in a).toBe(false);
    });
  });
});
