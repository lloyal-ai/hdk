/**
 * The mock refuses what the kernel refuses: a handle appearing twice in one
 * batched call, on BOTH rails.
 *
 * `BranchStore::decode_each` / `decode_scatter` call `require_distinct_handles`
 * for token batches, and the binding's `_storePrefillMultimodal` applies the
 * same rule before its worker runs (each entry's start position is read when
 * the batch is built and advances only after dispatch, so two entries on one
 * branch would collide on position). A mock that accepted the duplicate on
 * one rail would let a scheduler regression on that rail pass every test.
 */
import { describe, it, expect } from 'vitest';
import { MockSessionContext } from '../src/testing';
import { MEDIA_MARKER } from '../src/deltas';

describe('mock batches: a handle appears at most once per call', () => {
  it('token rail: a duplicate handle is refused', async () => {
    const ctx = new MockSessionContext({ nCtx: 4096 });
    const root = ctx._branchCreate(0);
    const child = ctx._branchFork(root);
    await expect(ctx._storePrefill([child, child], [[1], [2]])).rejects.toThrow(/duplicate handle/);
    await expect(ctx._storeCommit([child, child], [1, 2])).rejects.toThrow(/duplicate handle/);
  });

  it('embedding rail: a duplicate handle is refused the same way', async () => {
    const ctx = new MockSessionContext({ nCtx: 4096 });
    const root = ctx._branchCreate(0);
    const child = ctx._branchFork(root);
    const prompt = `look ${MEDIA_MARKER}`;
    await expect(ctx._storePrefillMultimodal([child, child], [[], []], [prompt, prompt], [[new Uint8Array([1])], [new Uint8Array([2])]]))
      .rejects.toThrow(/duplicate handle/);
  });
});
