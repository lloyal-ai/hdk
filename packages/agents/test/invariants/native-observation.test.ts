import { afterEach, expect, it, vi } from 'vitest';
import { InstrumentedMockSessionContext } from './harness';
import { MockSessionContext } from '../../../sdk/src/testing';

afterEach(() => vi.restoreAllMocks());

it('records a media cost query before it settles, including rejection', async () => {
  let reject!: (reason: Error) => void;
  vi.spyOn(MockSessionContext.prototype, '_cellsMultimodal').mockReturnValue(new Promise((_, no) => { reject = no; }));
  const ctx = new InstrumentedMockSessionContext();
  const pending = ctx._cellsMultimodal([], '<__media__>', [{ kind: 'audio', bytes: new Uint8Array([1]) }], { maxBytes: 10, maxSamples: 10 });
  const observedBeforeSettlement = ctx.nativeCalls.map(call => ({ ...call }));
  reject(new Error('invalid recording'));
  await expect(pending).rejects.toThrow('invalid recording');
  expect(observedBeforeSettlement).toMatchObject([{ op: 'cellsMultimodal', tEnd: Infinity }]);
  expect(ctx.nativeCalls).toHaveLength(1);
  expect(Number.isFinite(ctx.nativeCalls[0].tEnd)).toBe(true);
});

it('keeps a failed decode visible to native-access invariants', async () => {
  const ctx = new InstrumentedMockSessionContext();
  ctx.throwOnCommitToken = 7;
  await expect(ctx._storeCommit([1], [7])).rejects.toThrow('mock OOM');
  expect(ctx.nativeCalls).toMatchObject([{ op: 'commit', handles: [1] }]);
});

it('forwards typed inputs and their budgets through the instrumented prefill', async () => {
  const ctx = new InstrumentedMockSessionContext();
  const budget = { maxBytes: 1024, maxSamples: 16000 };
  const handle = ctx._branchCreate(0);
  const [result] = await ctx._storePrefillMultimodal([handle], [[]], ['<__media__>'], [[{ kind: 'audio', bytes: new Uint8Array([1]) }]], [budget]);
  expect(ctx.multimodalPrefills[0]).toMatchObject({ audioLimits: [budget], inputKinds: [['audio']] });
  expect(ctx.nativeCalls[0].tokenCount).toBe(result.tokensDecoded);
});
