/**
 * The trunk release observer — the other half of the pair with the prefill
 * observer. Prefills report what entered the trunk's KV; releases report a
 * trunk leaving it. The contracts:
 *
 *   1. `dispose()` of a live trunk fires ONCE, with the handle and position
 *      the trunk held at release; a trunkless dispose fires nothing.
 *   2. `promote(winner)` fires for the superseded live trunk — and does NOT
 *      fire when the winner already IS the trunk (re-crowning is a topology
 *      reset, not a release).
 *   3. Each cold `commitTurn` after a release opens a NEW generation: a
 *      fresh handle, observed by the prefill side. Release + rebirth is how
 *      a consumer (the dev pane) draws trunk-generation boundaries.
 */
import { describe, it, expect } from 'vitest';
import { Branch, BranchStore, Session } from '../src/index';
import { MockSessionContext } from '../src/testing.js';
import type { SessionContext } from '../src/types';

type Release = { branchHandle: number; position: number };
type Prefill = { role: string; branchHandle: number; cells: number };

function makeSession() {
  const ctx = new MockSessionContext() as unknown as SessionContext;
  const store = new BranchStore(ctx);
  const releases: Release[] = [];
  const prefills: Prefill[] = [];
  const session = new Session({
    ctx,
    store,
    onPrefill: ({ role, branchHandle, cells }) => prefills.push({ role, branchHandle, cells }),
    onRelease: (info) => releases.push(info),
  });
  return { ctx, store, session, releases, prefills };
}

describe('Session trunk release observer', () => {
  it('dispose of a live trunk fires once with its handle and position', async () => {
    const { session, releases, prefills } = makeSession();
    await session.commitTurn('q1', 'a1'); // cold: creates + promotes the trunk
    expect(releases).toEqual([]); // birth is not a release
    const born = prefills[0].branchHandle;
    const cells = prefills[0].cells;

    await session.dispose();
    expect(releases).toHaveLength(1);
    expect(releases[0].branchHandle).toBe(born);
    expect(releases[0].position).toBeGreaterThanOrEqual(cells);
    expect(session.trunk).toBeNull();

    await session.dispose(); // trunkless — nothing left to release
    expect(releases).toHaveLength(1);
  });

  it('release + rebirth opens a new generation (fresh handle)', async () => {
    const { session, releases, prefills } = makeSession();
    await session.commitTurn('q1', 'a1');
    const gen1 = prefills[0].branchHandle;
    await session.dispose();
    await session.commitTurn('q2', 'a2'); // cold again — the next generation
    const gen2 = prefills[1].branchHandle;
    expect(gen2).not.toBe(gen1);
    expect(releases).toHaveLength(1);
    expect(releases[0].branchHandle).toBe(gen1);
  });

  it('promote fires for a superseded live trunk, not for a re-crowned one', async () => {
    const { ctx, session, releases } = makeSession();
    const first = Branch.create(ctx, 0, {});
    session.trunk = first;
    await session.promote(first); // winner IS the trunk — no release
    expect(releases).toEqual([]);

    const winner = first.forkSync();
    await session.promote(winner); // the crown moves — first is freed
    expect(releases).toHaveLength(1);
    expect(releases[0].branchHandle).toBe(first.handle);
    expect(session.trunk).toBe(winner);
  });
});
