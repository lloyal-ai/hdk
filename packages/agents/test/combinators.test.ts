import { describe, it, expect } from 'vitest';
import { run, spawn, sleep, until } from 'effection';
import { waitUntilSettled } from '../src/combinators';

/**
 * waitUntilSettled is the one Effection helper that survives halt: a queued
 * native decode cannot be recalled, so the operation that issued it must not
 * exit until the promise has an outcome. Bare `until(p)` abandons the promise
 * on halt; this must wait for it.
 */
describe('waitUntilSettled', () => {
  it('returns the resolved value on the normal path', async () => {
    const v = await run(function* () {
      return yield* waitUntilSettled(Promise.resolve(42));
    });
    expect(v).toBe(42);
  });

  it('halt does not complete until the in-flight promise settles', async () => {
    await run(function* () {
      let settled = false;
      const p = new Promise<void>((r) => setTimeout(() => { settled = true; r(); }, 120));
      const task = yield* spawn(function* () {
        yield* waitUntilSettled(p);
      });
      yield* sleep(10);
      // Halt mid-flight. With a bare `until`, this resolves at ~10ms with the
      // promise still pending. waitUntilSettled must hold until it settles.
      yield* task.halt();
      expect(settled).toBe(true);
    });
  });

  it('a rejection during the halt wait surfaces nothing', async () => {
    await run(function* () {
      const p = new Promise<void>((_r, reject) => setTimeout(() => reject(new Error('boom')), 60));
      p.catch(() => {}); // keep the environment's unhandled-rejection guard quiet
      const task = yield* spawn(function* () {
        try { yield* waitUntilSettled(p); } catch { /* body rejection is the caller's */ }
      });
      yield* sleep(10);
      // Should resolve cleanly once the promise settles (rejected), no throw here.
      yield* task.halt();
      yield* until(p.then(() => 'ok', () => 'settled-rejected'));
    });
  });
});
