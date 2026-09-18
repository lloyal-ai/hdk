/**
 * `initAgents` owns the session; the context is the caller's unless the caller
 * says otherwise. Whoever creates a context disposes it — a boot, a served host
 * — and an initializer that also disposed it made every host dispose twice.
 * `NSeqMax` carries the resident context's sequence count for the pool.
 */
import { describe, it, expect } from 'vitest';
import { run, scoped } from 'effection';
import { MockSessionContext } from '../../sdk/src/testing.js';
import type { SessionContext } from '@lloyal-labs/sdk';
import { initAgents } from '../src/init';
import { NSeqMax } from '../src/context';

describe('initAgents', () => {
  it('disposes the context at scope exit by default, and leaves it alone when told the caller owns it', async () => {
    const owned = new MockSessionContext({ nCtx: 4096 });
    const lent = new MockSessionContext({ nCtx: 4096 });
    await run(function* () {
      yield* scoped(function* () { yield* initAgents(owned as unknown as SessionContext); });
      yield* scoped(function* () { yield* initAgents(lent as unknown as SessionContext, { disposeContext: false }); });
    });
    expect(owned.disposeCount).toBe(1);
    expect(lent.disposeCount).toBe(0);
  });
});

describe('NSeqMax', () => {
  it('is unset until a boot carries it', async () => {
    await run(function* () {
      expect(yield* NSeqMax.get()).toBeUndefined();
      yield* NSeqMax.set(3);
      expect(yield* NSeqMax.expect()).toBe(3);
    });
  });
});
