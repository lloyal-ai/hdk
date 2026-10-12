/**
 * Scenario: the chat parser never leaves the native side. A format mints the handle that owns its parser;
 * every parse the pool issues hands that handle back. The mock context mints handles the way the addon
 * does, so this is the contract the SDK's `parser` handle carries, exercised end to end through the pool
 * rather than asserted on a field.
 */
import { describe, it, expect } from 'vitest';
import type { Operation } from 'effection';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { Tool } from '../../../src/Tool';
import { runPool, STOP } from '../harness';
import type { PoolRun } from '../harness';
import type { ChatParser } from '@lloyal-labs/sdk';
import { I45_parseHandsBackAMintedParser } from '../predicates';

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

describe('scenario: a parse hands back the parser its format minted', () => {
  it('every parse in a turn with tools hands back a handle a format produced', async () => {
    const run = await runPool({
      nCtx: 4096, cellsUsed: 0, tools: new Map<string, Tool>([['search', new Plain('search')]]), policy: idle,
      scripts: [{ tokens: [1, 2, STOP], content: 'done' }],
    });
    expect(run.parsers.parsed.length).toBeGreaterThan(0);
    expect(run.parsers.formatted.length).toBeGreaterThan(0);
    for (const parser of run.parsers.parsed) expect(run.parsers.formatted).toContain(parser);
    expect(I45_parseHandsBackAMintedParser(run)).toEqual({ ok: true, violations: [] });
  });

  it('the predicate refuses a parse with no handle and a parse with a handle the context never minted', () => {
    const minted = { minted: 0 } as unknown as ChatParser;
    const runOf = (parsed: (ChatParser | undefined)[]): PoolRun =>
      ({ parsers: { formatted: [minted], parsed } } as unknown as PoolRun);
    expect(I45_parseHandsBackAMintedParser(runOf([minted])).ok).toBe(true);
    expect(I45_parseHandsBackAMintedParser(runOf([undefined])).ok).toBe(false);
    expect(I45_parseHandsBackAMintedParser(runOf([{ minted: 0 } as unknown as ChatParser])).ok).toBe(false);
  });
});
