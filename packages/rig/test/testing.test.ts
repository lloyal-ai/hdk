/**
 * The behavioural rig's platform half: what an application's scenarios stand on.
 */
import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import { admitChunks } from '@lloyal-labs/lloyal-agents';
import type { Chunk } from '@lloyal-labs/lloyal-agents';
import { stubReranker } from '../src/testing';

const chunk = (i: number): Chunk => ({ resource: `r${i}.md`, heading: `H${i}`, section: `S${i}`, text: `text ${i} `.repeat(30), tokens: [], startLine: 1, endLine: 3 });

describe('stubReranker', () => {
  it('admits every chunk it is given, scored 0, in the order given — a retrieval under the rig is never silently empty', async () => {
    const chunks = [chunk(1), chunk(2), chunk(3)];
    const batches: unknown[] = [];
    for await (const b of stubReranker.score('q', chunks)) batches.push(b);
    expect(batches).toHaveLength(1);
    const admitted = await run(() => admitChunks(stubReranker, chunks, 'q', undefined, { tool: 'search', select: { mode: 'budget', topK: 10, tokenBudget: 10_000 } }));
    expect(admitted.scored.map((c) => c.file)).toEqual(['r1.md', 'r2.md', 'r3.md']);
    expect(admitted.scored.every((c) => c.score === 0)).toBe(true);
  });
});
