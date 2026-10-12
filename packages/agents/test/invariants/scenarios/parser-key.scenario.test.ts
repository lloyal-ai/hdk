/**
 * Scenario: the chat parser never leaves the native context. A format mints a key for the options that
 * shape the parser; every parse the pool issues hands that key back. The mock context mints keys the way
 * the addon does, so this is the contract the SDK's `parser` string carries, exercised end to end through
 * the pool rather than asserted on a field.
 */
import { describe, it, expect } from 'vitest';
import type { Operation } from 'effection';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { Tool } from '../../../src/Tool';
import { runPool, STOP } from '../harness';
import type { PoolRun } from '../harness';
import { I45_parseHandsBackAMintedKey } from '../predicates';

class Plain extends Tool<Record<string, unknown>> {
  readonly parameters = { type: 'object', properties: {} };
  constructor(readonly name: string) { super(); }
  readonly description = 'a tool';
  *execute(): Operation<unknown> { return { ok: true }; }
}

const idle: AgentPolicy = {
  onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
  shouldExit: () => false,
};

describe('scenario: a parse hands back the key its format minted', () => {
  it('every parse in a turn with tools names the key the tool set produced', async () => {
    const run = await runPool({
      nCtx: 4096, cellsUsed: 0, tools: new Map<string, Tool>([['search', new Plain('search')]]), policy: idle,
      scripts: [{ tokens: [1, 2, STOP], content: 'done' }],
    });
    expect(run.parserKeys.parsed.length).toBeGreaterThan(0);
    expect(run.parserKeys.formatted.length).toBeGreaterThan(0);
    for (const key of run.parserKeys.parsed) expect(run.parserKeys.formatted).toContain(key);
    expect(I45_parseHandsBackAMintedKey(run)).toEqual({ ok: true, violations: [] });
  });

  it('the predicate refuses a parse with no key and a parse with a key the context never minted', () => {
    const runOf = (parsed: (string | undefined)[]): PoolRun =>
      ({ parserKeys: { formatted: ['parser:{"tools":"[]"}'], parsed } } as unknown as PoolRun);
    expect(I45_parseHandsBackAMintedKey(runOf(['parser:{"tools":"[]"}'])).ok).toBe(true);
    expect(I45_parseHandsBackAMintedKey(runOf([undefined])).ok).toBe(false);
    expect(I45_parseHandsBackAMintedKey(runOf(['parser:invented'])).ok).toBe(false);
  });
});
