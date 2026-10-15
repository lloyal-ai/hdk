/**
 * Fast-forward: a child's state becomes its parent's, the parent keeping its
 * handle (git merge --ff-only). With fork and prune it is a checkpoint any
 * branch can keep or discard while the rest of the tree runs on.
 *
 * The kernel's own proof runs on real weights (liblloyal's integration
 * suite). These cases pin the SDK's side of it, and that the mock refuses what
 * the kernel refuses, with the kernel's words, so a harness test that relies
 * on a refusal sees the one production would raise.
 */
import { describe, it, expect } from 'vitest';
import { MockSessionContext } from '../src/testing';
import { Branch } from '../src/Branch';
import { MEDIA_MARKER } from '../src/deltas';

function rig() {
  const ctx = new MockSessionContext({ nCtx: 4096 });
  const parent = Branch.create(ctx as never, 0, {});
  return { ctx, parent };
}

describe('Branch.fastForward', () => {
  it('the parent takes the child\'s position and keeps its handle; the child is gone and the cells stay', async () => {
    const { ctx, parent } = rig();
    await parent.prefill([1, 2, 3]);
    const sibling = await parent.fork();
    const child = await parent.fork();
    await child.prefill([4, 5, 6, 7]);
    const handle = parent.handle;
    const cells = ctx.cellsUsed;

    parent.fastForwardSync(child);

    expect(parent.handle).toBe(handle);
    expect(parent.position).toBe(7);
    expect(child.disposed).toBe(true);
    expect(parent.children).toEqual([sibling.handle]);
    expect(ctx.cellsUsed, 'no cells move: the child\'s were counted when decoded').toBe(cells);

    parent.pruneSubtreeSync();
    expect(ctx.cellsUsed).toBe(0);
  });

  it('carries the child\'s image slack, so releasing the parent recovers every cell', async () => {
    const { ctx, parent } = rig();
    const child = await parent.fork();
    const [r] = await ctx._storePrefillMultimodal([child.handle], [[]], [`look ${MEDIA_MARKER}`], [[new Uint8Array([1])]]);
    expect(r.tokensDecoded).toBeGreaterThan(r.positionAdvance);

    await parent.fastForward(child);
    expect(ctx.cellsUsed).toBe(r.tokensDecoded);
    parent.pruneSync();
    expect(ctx.cellsUsed).toBe(0);
  });

  it('is refused, with nothing changed, unless the child is the parent\'s own and the parent is as it was', async () => {
    const { ctx, parent } = rig();
    await parent.prefill([1, 2, 3]);
    const child = await parent.fork();
    const sibling = await parent.fork();
    await child.prefill([4]);
    const unrelated = Branch.create(ctx as never, 0, {});

    const refused = (p: Branch, c: Branch, why: RegExp) => {
      const before = [p.position, c.position, ctx.cellsUsed];
      expect(() => p.fastForwardSync(c)).toThrow(why);
      expect([p.position, c.position, ctx.cellsUsed]).toEqual(before);
      expect(c.disposed).toBe(false);
    };
    refused(parent, unrelated, /the child was not forked from this parent/);
    refused(sibling, child, /the child was not forked from this parent/);
    refused(parent, parent, /the child was not forked from this parent/);

    const grandchild = await child.fork();
    refused(parent, child, /the child has children of its own/);
    grandchild.pruneSync();

    const decodedAfter = await parent.fork();
    await parent.prefill([9]);
    refused(parent, decodedAfter, /the parent has decoded since the fork/);
    decodedAfter.pruneSync();

    const changedAfter = await parent.fork();
    parent.accept(5);
    refused(parent, changedAfter, /the parent has changed since the fork/);
    changedAfter.pruneSync();

    const reseededAfter = await parent.fork();
    parent.reseedSampler(7);
    refused(parent, reseededAfter, /the parent has changed since the fork/);
    reseededAfter.pruneSync();

    parent.pruneSubtreeSync();
    unrelated.pruneSync();
  });

  it('refuses a child poisoned by a failed prefill; pruning it leaves the parent whole', async () => {
    const { ctx, parent } = rig();
    await parent.prefill([1, 2, 3]);
    const child = await parent.fork();
    ctx.mockMultimodalError = () => ({ message: 'llama_decode failed', rc: 1, partial: true });
    await expect(child.prefillMultimodal(`look ${MEDIA_MARKER}`, [new Uint8Array([1])])).rejects.toThrow(/llama_decode failed/);

    expect(() => parent.fastForwardSync(child)).toThrow(/the child is poisoned by a failed decode/);
    child.pruneSync();
    expect(parent.position).toBe(3);
    expect(ctx.cellsUsed).toBe(3);
    parent.pruneSync();
  });

  it('a refusal that restored the call does not poison', async () => {
    const { ctx, parent } = rig();
    const child = await parent.fork();
    ctx.mockMultimodalError = () => ({ message: 'no KV slot', rc: 1, partial: false });
    await expect(child.prefillMultimodal(`look ${MEDIA_MARKER}`, [new Uint8Array([1])])).rejects.toThrow(/no KV slot/);
    expect(() => parent.fastForwardSync(child)).not.toThrow();
    parent.pruneSync();
  });

  it('refuses a child from another context, even one whose handle matches, with nothing consumed', async () => {
    const { ctx, parent } = rig();
    const ownChild = await parent.fork();
    const other = rig();
    const foreignChild = await other.parent.fork();
    expect(foreignChild.handle).toBe(ownChild.handle);

    expect(() => parent.fastForwardSync(foreignChild)).toThrow(/another context/);
    expect(ownChild.disposed).toBe(false);
    expect(foreignChild.disposed).toBe(false);
    expect(parent.children).toEqual([ownChild.handle]);
    expect(other.parent.children).toEqual([foreignChild.handle]);

    parent.fastForwardSync(ownChild);
    other.parent.pruneSubtreeSync();
    parent.pruneSync();
    expect(ctx.cellsUsed).toBe(0);
  });

  it('refuses a disposed branch on either side before reaching the context', async () => {
    const { parent } = rig();
    const child = await parent.fork();
    child.pruneSync();
    expect(() => parent.fastForwardSync(child)).toThrow(/disposed/);
    parent.pruneSync();
    expect(() => parent.fastForwardSync(child)).toThrow(/disposed/);
  });
});
