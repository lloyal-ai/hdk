/**
 * The mock releases a context the way the binding does: `dispose()` answers a
 * promise, resolved once the context is freed, and every call answers the
 * same one.
 */
import { describe, it, expect } from 'vitest';
import { MockSessionContext } from '../src/testing';

describe('mock dispose', () => {
  it('answers one promise, resolved once the context is freed, however often it is called', async () => {
    const ctx = new MockSessionContext();
    const freed = ctx.dispose();
    expect(freed).toBeInstanceOf(Promise);
    expect(ctx.dispose()).toBe(freed);
    await expect(freed).resolves.toBeUndefined();
    expect(ctx.disposeCount).toBe(2);
  });
});
