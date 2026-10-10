import { expect, it, vi } from 'vitest';
import { ensure, run } from 'effection';
import { Branch, BranchStore, buildUserDeltaMultimodal } from '@lloyal-labs/sdk';
import type { MultimodalPrefillResult } from '@lloyal-labs/sdk';
import { MockSessionContext } from '../../sdk/src/testing';
import { Store } from '../src/context';
import { runReplay } from '../src/replay';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it.each(['resolve', 'reject'] as const)('audio replay forwards its admission budget and settles before pruning on halt (%s)', async outcome => {
  const ctx = new MockSessionContext();
  const branch = Branch.create(ctx, 0);
  const store = new BranchStore(ctx);
  const budget = { maxBytes: 1024, maxSamples: 16000 };
  const delta = buildUserDeltaMultimodal(ctx, '', [{ kind: 'audio', bytes: new Uint8Array([1]) }], { audioLimits: budget });
  const started = deferred<void>();
  const decode = deferred<MultimodalPrefillResult[]>();
  const prefill = vi.spyOn(ctx, '_storePrefillMultimodal').mockImplementation(() => {
    started.resolve();
    return decode.promise;
  });
  let continued = false;
  const task = run(function* () {
    yield* Store.set(store);
    yield* ensure(() => branch.pruneSync());
    yield* runReplay(branch, [{ kind: 'media', delta, cells: 8 }]);
    continued = true;
  });
  await started.promise;
  const halting = task.halt();
  await new Promise(resolve => setTimeout(resolve, 10));
  const prunedBeforeSettlement = branch.disposed;
  if (outcome === 'resolve') decode.resolve([{ tokensDecoded: 8, positionAdvance: 8 }]);
  else decode.reject(new Error('native decode failed'));
  await halting;
  expect(prunedBeforeSettlement).toBe(false);
  expect(branch.disposed).toBe(true);
  expect(continued).toBe(false);
  expect(prefill.mock.calls[0][4]).toEqual([budget]);
});
