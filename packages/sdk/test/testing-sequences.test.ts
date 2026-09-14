/**
 * The mock's sequence budget: `nSeqMax` leases, one per live branch, the root's
 * included. `BranchStore.available` counts the vacant ones; a fork with none
 * vacant fails the way the binding fails ("Failed to fork branch"); a prune
 * gives the lease back. Absent `nSeqMax`, the mock is unbudgeted.
 */
import { describe, it, expect } from 'vitest';
import { createMockSdk } from '../src/testing.js';

describe('MockSessionContext sequences', () => {
  it('counts leases: the root holds one, each fork one more, a prune returns it', () => {
    const { store, root } = createMockSdk({ nSeqMax: 3 });
    expect(store.available).toBe(2);
    const a = root.forkSync();
    const b = root.forkSync();
    expect(store.available).toBe(0);
    expect(() => root.forkSync()).toThrow('Failed to fork branch');
    a.pruneSync();
    expect(store.available).toBe(1);
    const c = root.forkSync();
    expect(store.available).toBe(0);
    b.pruneSync(); c.pruneSync();
    expect(store.available).toBe(2);
  });

  it('is unbudgeted when nSeqMax is not given', () => {
    const { store, root } = createMockSdk();
    const before = store.available;
    for (let i = 0; i < 40; i++) root.forkSync();
    expect(store.available).toBe(before);
    expect(before).toBeGreaterThan(1000);
  });
});
