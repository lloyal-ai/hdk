import { describe, it, expect } from 'vitest';
import { run, spawn, sleep } from 'effection';
import { Agent } from '../src/Agent';
import { createMockBranch } from './helpers/mock-branch';

import { FMT } from './helpers/format-config';

function makeAgent(opts?: { parent?: Agent; id?: number }) {
  const branch = createMockBranch({ handle: opts?.id ?? 1 });
  return new Agent({
    id: opts?.id ?? 1,
    parentId: 0,
    branch: branch as any,
    fmt: FMT,
    parent: opts?.parent ?? null,
  });
}

describe('Agent', () => {
  describe('status transitions', () => {
    it('allows idle → active', () => {
      const a = makeAgent();
      a.transition('active');
      expect(a.status).toBe('active');
    });

    it('allows active → awaiting_tool', () => {
      const a = makeAgent();
      a.transition('active');
      a.transition('awaiting_tool');
      expect(a.status).toBe('awaiting_tool');
    });

    it('allows active → idle', () => {
      const a = makeAgent();
      a.transition('active');
      a.transition('idle');
      expect(a.status).toBe('idle');
    });

    it('allows awaiting_tool → active', () => {
      const a = makeAgent();
      a.transition('active');
      a.transition('awaiting_tool');
      a.transition('active');
      expect(a.status).toBe('active');
    });

    it('allows awaiting_tool → idle', () => {
      const a = makeAgent();
      a.transition('active');
      a.transition('awaiting_tool');
      a.transition('idle');
      expect(a.status).toBe('idle');
    });

    it('allows idle → disposed', () => {
      const a = makeAgent();
      a.transition('disposed');
      expect(a.status).toBe('disposed');
    });

    it('rejects idle → awaiting_tool (idle is final: every drop decides its recovery while the agent is live)', () => {
      const a = makeAgent();
      expect(() => a.transition('awaiting_tool')).toThrow('Invalid agent status transition');
    });

    it('rejects active → disposed', () => {
      const a = makeAgent();
      a.transition('active');
      expect(() => a.transition('disposed')).toThrow('Invalid agent status transition');
    });

    it('rejects disposed → active', () => {
      const a = makeAgent();
      a.dispose();
      expect(() => a.transition('active')).toThrow('Invalid agent status transition');
    });
  });

  describe('final', () => {
    // `final` is the one future an orchestrator waits on: it resolves the first
    // time the agent reaches a final status AFTER it lived, and never for the
    // pre-activation idle an agent is born with.
    it('is not resolved by the idle an agent is born with', async () => {
      const a = makeAgent();
      let settled = false;
      await run(function* () {
        yield* spawn(function* () { yield* a.final; settled = true; });
        yield* sleep(5);
      });
      expect(settled).toBe(false);
    });

    it('resolves on the first idle after activation, and stays resolved', async () => {
      const a = makeAgent();
      a.transition('active');
      a.transition('idle');
      const order: string[] = [];
      await run(function* () {
        yield* a.final; order.push('first');
        yield* a.final; order.push('again');   // a future: the same outcome every time
      });
      expect(order).toEqual(['first', 'again']);
    });

    it('resolves on dispose, however the agent got there', async () => {
      const a = makeAgent();
      a.dispose();
      let settled = false;
      await run(function* () { yield* a.final; settled = true; });
      expect(settled).toBe(true);
    });
  });

  describe('token accounting', () => {
    it('accumulates tokens', () => {
      const a = makeAgent();
      a.accumulateToken('hello');
      a.accumulateToken(' world');
      expect(a.rawOutput).toBe('hello world');
      expect(a.tokenCount).toBe(2);
    });

    it('resets turn output', () => {
      const a = makeAgent();
      a.accumulateToken('hello');
      a.resetTurn();
      expect(a.rawOutput).toBe('');
    });

    it('increments tool calls and turns', () => {
      const a = makeAgent();
      a.incrementToolCalls();
      a.incrementToolCalls();
      a.incrementTurns();
      expect(a.toolCallCount).toBe(2);
      expect(a.turns).toBe(1);
    });

  });

  describe('findings', () => {
    it('reports findings with provenance', () => {
      const a = makeAgent();
      a.setResult('found something', 'voluntary_return');
      expect(a.result).toBe('found something');
      expect(a.resultSource).toBe('voluntary_return');
    });

    it('overwrites on second report', () => {
      const a = makeAgent();
      a.setResult('first', 'voluntary_return');
      a.setResult('second', 'recovery');
      expect(a.result).toBe('second');
      expect(a.resultSource).toBe('recovery');
    });
  });

  describe('nestedResults', () => {
    it('starts empty', () => {
      const a = makeAgent();
      expect(a.nestedResults).toEqual([]);
    });

    it('accumulates across addNestedResults calls', () => {
      const a = makeAgent();
      a.addNestedResults(['a', 'b']);
      a.addNestedResults(['c']);
      expect([...a.nestedResults]).toEqual(['a', 'b', 'c']);
    });
  });

  describe('tool history', () => {
    it('records tool results', () => {
      const a = makeAgent();
      a.recordToolResult({
        name: 'web_search', args: 'test query',
        resultCells: 100, contextAfterPercent: 80, timestamp: 0, outcome: 'toolResult',
      });
      expect(a.toolHistory).toHaveLength(1);
      expect(a.toolHistory[0].name).toBe('web_search');
    });
  });

  describe('walkAncestors', () => {
    it('returns own data when no parent', () => {
      const a = makeAgent();
      a.recordToolResult({ name: 'search', args: 'q', resultCells: 0, contextAfterPercent: 100, timestamp: 0, outcome: 'toolResult' });
      const result = a.walkAncestors((agent) => agent.toolHistory);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('search');
    });

    it('traverses self → parent → grandparent', () => {
      const grandparent = makeAgent({ id: 1 });
      grandparent.recordToolResult({ name: 'gp', args: '', resultCells: 0, contextAfterPercent: 100, timestamp: 0, outcome: 'toolResult' });

      const parent = makeAgent({ id: 2, parent: grandparent });
      parent.recordToolResult({ name: 'p', args: '', resultCells: 0, contextAfterPercent: 100, timestamp: 0, outcome: 'toolResult' });

      const child = makeAgent({ id: 3, parent });
      child.recordToolResult({ name: 'c', args: '', resultCells: 0, contextAfterPercent: 100, timestamp: 0, outcome: 'toolResult' });

      const names = child.walkAncestors((a) => a.toolHistory).map((h) => h.name);
      expect(names).toEqual(['c', 'p', 'gp']);
    });
  });

  describe('attendedResults', () => {
    // What the pool books once a result LANDS on the branch — never the tool.
    // `outcome` is the only thing that separates a delivered result from a
    // settle-reject nudge, which carries the ORIGINAL call's name and args.
    const booked = (name: string, args: object, outcome: 'toolResult' | 'nudge' | 'recovery' = 'toolResult') =>
      ({ name, args: JSON.stringify(args), resultCells: 10, contextAfterPercent: 90, timestamp: 0, outcome } as any);

    it('returns the parsed args of this tool\'s attended calls — self then ancestors', () => {
      const parent = makeAgent({ id: 1 });
      parent.recordToolResult(booked('read_file', { filename: 'a.md', startLine: 1, endLine: 20 }));
      const child = makeAgent({ id: 2, parent });
      child.recordToolResult(booked('read_file', { filename: 'b.md', startLine: 1, endLine: 5 }));
      expect(child.attendedResults('read_file')).toEqual([
        { filename: 'b.md', startLine: 1, endLine: 5 },
        { filename: 'a.md', startLine: 1, endLine: 20 },
      ]);
    });

    it('excludes a nudge and a recovery — only an attended result counts', () => {
      const a = makeAgent();
      a.recordToolResult(booked('read_file', { filename: 'a.md' }, 'nudge'));
      a.recordToolResult(booked('recovery', {}, 'recovery'));
      a.recordToolResult(booked('read_file', { filename: 'b.md' }));
      expect(a.attendedResults('read_file')).toEqual([{ filename: 'b.md' }]);
    });

    it('filters by tool name', () => {
      const a = makeAgent();
      a.recordToolResult(booked('fetch_page', { url: 'x' }));
      a.recordToolResult(booked('web_search', { query: 'q' }));
      expect(a.attendedResults('fetch_page')).toEqual([{ url: 'x' }]);
    });
  });

  describe('branch-derived readings', () => {
    it('exposes position and forkHead', () => {
      const branch = createMockBranch({ position: 500, forkHead: 200 });
      const a = new Agent({ id: 1, parentId: 0, branch: branch as any, fmt: FMT });
      expect(a.position).toBe(500);
      expect(a.forkHead).toBe(200);
      expect(a.uniqueCells).toBe(300);
    });
  });
});
