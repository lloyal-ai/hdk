/**
 * `Branch.setGrammarOrder`: the one word the SDK adds for how a branch consults its grammar.
 *
 * The engine keeps the order on the branch, mask-first by default, and resets it whenever a grammar is
 * attached; the SDK's job is to say the word faithfully and nothing more. These lock the translation
 * (`'sampleFirst'` is the only order that asks for `true`) and the refusal on a disposed branch, so a
 * caller that forgets the order resets on attach gets the engine's answer, not a silently kept flag.
 */
import { describe, it, expect, vi } from 'vitest';
import { MockSessionContext } from '../src/testing.js';
import { Branch } from '../src/Branch';

const ctx = () => new MockSessionContext({ nCtx: 4096, cellsUsed: 0 });

describe('Branch.setGrammarOrder', () => {
  it("asks the engine for sample-first with true and for mask-first with false, on this branch's handle", () => {
    const c = ctx();
    const spy = vi.spyOn(c, '_branchSetGrammarOrder');
    const b = Branch.create(c as never, 0, {});
    b.setGrammarOrder('sampleFirst');
    b.setGrammarOrder('maskFirst');
    expect(spy.mock.calls).toEqual([[b.handle, true], [b.handle, false]]);
  });

  it('refuses on a disposed branch, like every other setter', () => {
    const c = ctx();
    const b = Branch.create(c as never, 0, {});
    b.pruneSync();
    expect(() => b.setGrammarOrder('sampleFirst')).toThrow(/disposed/);
  });
});
