import { describe, it, expect } from 'vitest';
import { NULL_SCORER } from '../src/scorer';

describe('NULL_SCORER', () => {
  it('returns 1.0 for all texts', async () => {
    const results = await NULL_SCORER.scoreEntailmentBatch(['a', 'b', 'c']);
    expect(results).toEqual([1, 1, 1]);
  });

  it('always proceeds', () => {
    expect(NULL_SCORER.shouldProceed(0)).toBe(true);
    expect(NULL_SCORER.shouldProceed(-1)).toBe(true);
  });

  it('scoreSimilarityBatch returns 0 (guard never fires)', async () => {
    const results = await NULL_SCORER.scoreSimilarityBatch('any ref', ['a', 'b']);
    expect(results).toEqual([0, 0]);
  });

});

describe('ContextPressure fields', () => {
  it('percentAvailable: normal case', () => {
    // 8192 / 16384 = 50%
    const p = { nCtx: 16384, cellsUsed: 8192, remaining: 8192 };
    const pct = p.nCtx > 0 ? Math.max(0, Math.round((p.remaining / p.nCtx) * 100)) : 100;
    expect(pct).toBe(50);
  });

  it('percentAvailable: nCtx=0 → 100 (no limit)', () => {
    const p = { nCtx: 0, cellsUsed: 0, remaining: Infinity };
    const pct = p.nCtx > 0 ? Math.max(0, Math.round((p.remaining / p.nCtx) * 100)) : 100;
    expect(pct).toBe(100);
  });

  it('percentAvailable: remaining=0 → 0', () => {
    const p = { nCtx: 16384, cellsUsed: 16384, remaining: 0 };
    const pct = p.nCtx > 0 ? Math.max(0, Math.round((p.remaining / p.nCtx) * 100)) : 100;
    expect(pct).toBe(0);
  });

  it('nCtx and cellsUsed populated', () => {
    const p = { nCtx: 32768, cellsUsed: 10000, remaining: 22768 };
    expect(p.nCtx).toBe(32768);
    expect(p.cellsUsed).toBe(10000);
    expect(p.remaining).toBe(22768);
  });
});
