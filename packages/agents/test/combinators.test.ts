import { describe, it, expect } from 'vitest';
import { race, run, spawn, sleep, suspend, until, withResolvers } from 'effection';
import type { Operation } from 'effection';
import { makePermits, waitUntilSettled } from '../src/combinators';

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

/**
 * The FIFO gate: a permit is never lost, however its holder or a waiter
 * leaves. A lost permit is a gate that never opens again.
 */
describe('makePermits', () => {
  /** The operation, or a refusal naming it, so a lost permit fails the test rather than hanging it. */
  function* within<T>(name: string, op: Operation<T>): Operation<T> {
    return yield* race([op, (function* (): Operation<T> { yield* sleep(200); throw new Error(`${name} never got a permit`); })()]);
  }

  it('grants in the order asked, one at a time', async () => {
    const log: string[] = [];
    await run(function* () {
      const gate = makePermits(1);
      const holder = (name: string) => spawn(() => gate.hold(function* () {
        log.push(`${name}:in`);
        yield* sleep(5);
        log.push(`${name}:out`);
      }));
      const tasks = [yield* holder('a'), yield* holder('b'), yield* holder('c')];
      for (const t of tasks) yield* t;
    });
    expect(log).toEqual(['a:in', 'a:out', 'b:in', 'b:out', 'c:in', 'c:out']);
  });

  it('a waiter halted while it waits leaves the queue, and the permit goes to the next', async () => {
    const log: string[] = [];
    await run(function* () {
      const gate = makePermits(1);
      const running = withResolvers<void>();
      const holder = yield* spawn(() => gate.hold(() => running.operation));
      yield* sleep(0);
      const waiter = yield* spawn(() => gate.hold(function* () { log.push('halted waiter ran'); }));
      yield* sleep(0);
      yield* waiter.halt();
      running.resolve();
      yield* holder;
      yield* within('the next caller', gate.hold(function* () {}));
    });
    expect(log).toEqual([]);
  });

  it('a waiter halted after it was handed the permit, before it resumed, gives it back', async () => {
    await run(function* () {
      const gate = makePermits(1);
      const running = withResolvers<void>();
      const holder = yield* spawn(() => gate.hold(() => running.operation));
      yield* sleep(0);
      const waiter = yield* spawn(() => gate.hold(function* () {}));
      yield* sleep(0);
      // The holder ends and the waiter is halted in the same turn: the permit is handed over, never resumed into.
      running.resolve();
      yield* holder;
      yield* waiter.halt();
      yield* within('the next caller', gate.hold(function* () {}));
    });
  });

  it('a holder halted inside its work gives the permit back', async () => {
    await run(function* () {
      const gate = makePermits(1);
      const holder = yield* spawn(() => gate.hold(() => suspend()));
      yield* sleep(0);
      yield* holder.halt();
      yield* within('the next caller', gate.hold(function* () {}));
    });
  });
});
