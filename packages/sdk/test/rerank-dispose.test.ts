/**
 * Releasing a reranker under a score in flight: the native prefill of that score
 * may still be running on the branches a release prunes, so nothing is pruned or
 * freed until the score has settled, and the release resolves after it.
 */
import { describe, it, expect, vi } from 'vitest';
import { Rerank } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';
import { MockSessionContext } from '../src/testing.js';

describe('Rerank.dispose under a score in flight', () => {
  it('prunes and frees only once every native call of the score in flight has landed, and resolves after it', async () => {
    const ctx = new MockSessionContext();
    const rerank = await Rerank.create(ctx as unknown as SessionContext, {});
    const events: string[] = [];
    let land!: () => void;
    const landed = new Promise<void>((resolve) => { land = resolve; });
    const prefill = ctx._storePrefill.bind(ctx);
    vi.spyOn(ctx, '_storePrefill').mockImplementation(async (...args) => {
      events.push('prefill');
      await landed;
      events.push('prefill landed');
      return prefill(...args);
    });
    const pruneSubtree = ctx._branchPruneSubtree.bind(ctx);
    vi.spyOn(ctx, '_branchPruneSubtree').mockImplementation((handle) => { events.push('prune'); pruneSubtree(handle); });
    const dispose = ctx.dispose.bind(ctx);
    vi.spyOn(ctx, 'dispose').mockImplementation(() => { events.push('dispose'); return dispose(); });

    const scored = rerank.scoreBatch('a query', ['a document']).then(() => events.push('scored'), () => events.push('scored'));
    await vi.waitFor(() => expect(events).toContain('prefill'));
    const freed = rerank.dispose().then(() => events.push('freed'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(['prefill']);

    land();
    await Promise.all([scored, freed]);
    expect(events.indexOf('prefill landed')).toBeLessThan(events.indexOf('prune'));
    expect(events.lastIndexOf('prefill landed')).toBeLessThan(events.indexOf('dispose'));
    expect(events).toContain('scored');
    expect(events.at(-1)).toBe('freed');
  });
});
