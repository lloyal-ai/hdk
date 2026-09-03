/**
 * `Branch.disposed` can LIE, and why that is survivable.
 *
 * `pruneSubtreeSync()` frees an entire subtree natively but sets the local
 * `_disposed` flag only on the receiver — so every descendant `Branch` OBJECT
 * is left stale-but-undisposed. Any holder of those objects (an agent pool
 * tearing down agents, where a sub-spawned agent's branch is a child of its
 * spawner's) will read `disposed === false` for a slot that is already gone.
 *
 * That is survivable ONLY because the kernel is generation-checked:
 * `reset_slot` bumps the slot generation ("Prevent ABA") and `BranchStore::get`
 * refuses a handle whose generation no longer matches, so `prune()` returns
 * early. These lock both halves — the flag lies, and the second free is inert —
 * because a change to either would turn a benign staleness into a real
 * use-after-free, and nothing else in the suite states the dependency.
 */
import { describe, it, expect } from 'vitest';
import { MockSessionContext } from '../src/testing.js';
import { Branch } from '../src/Branch';

const ctx = () => new MockSessionContext({ nCtx: 4096, cellsUsed: 0 });

describe('subtree pruning and stale branch objects', () => {
  it('leaves DESCENDANT objects stale-but-undisposed', () => {
    const c = ctx();
    const parent = Branch.create(c as never, 0, {});
    const child = parent.forkSync();

    parent.pruneSubtreeSync();

    expect(parent.disposed).toBe(true);
    expect(child.disposed, 'the child was freed natively but its object does not know')
      .toBe(false);
  });

  it('treats a second free of that stale object as a NO-OP', () => {
    // The property the staleness above depends on. If the kernel ever stopped
    // generation-checking, this is the test that should fail first.
    const c = ctx();
    const parent = Branch.create(c as never, 0, {});
    const child = parent.forkSync();
    parent.pruneSubtreeSync();

    expect(() => child.pruneSubtreeSync()).not.toThrow();
  });

  it('a liveness-checked, children-first pass frees each slot once', () => {
    // What a teardown holding many branches should do regardless: ask the
    // CONTEXT whether children are live, and let each object set its own flag.
    const c = ctx();
    const parent = Branch.create(c as never, 0, {});
    const child = parent.forkSync();

    const safe = (b: Branch): void => {
      if (!b.disposed && b.children.length === 0) b.pruneSync();
    };
    for (const b of [parent, child].reverse()) safe(b);

    expect(child.disposed).toBe(true);
    expect(parent.disposed).toBe(true);
  });
});
