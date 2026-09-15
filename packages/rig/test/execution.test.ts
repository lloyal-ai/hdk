/**
 * The execution owner: one live operation per session, accepted at once and
 * sequenced in the owner's own loop. Nothing a handler calls waits on native
 * work — `replace` and `stop` post to the mailbox and return — so Stop is
 * dispatched during the slowest cleanup and a continuation accepted behind a
 * closing turn never starts once withdrawn.
 *
 * The contract, as laws:
 *   1. `replace` returns before the current operation's halt completes; the
 *      loop halts, then starts.
 *   2. `stop` withdraws an accepted operation that has not started; it never
 *      runs, and its future settles. A running operation it halts settles too,
 *      once the halt has completed.
 *   3. A `replace` behind another withdraws it: the mailbox never holds two.
 *   4. The accepted future resolves when the operation returns and rejects
 *      when it throws; an ordinary failure does not poison the owner.
 *   5. A halt whose teardown throws poisons the owner: the pending operation's
 *      future rejects with that error, and `replace`/`stop` throw from then on.
 *      A cleanup that fails inside a `scoped()` boundary the operation holds is
 *      thrown through the operation's frames as they unwind; caught and rethrown
 *      by the operation's own handler, it poisons the same way.
 *   6. `busy` holds from acceptance until the halt completes; `current` names
 *      what runs or is accepted.
 */
import { describe, it, expect } from 'vitest';
import { run, ensure, sleep, suspend, until, createSignal, spawn, each, scoped } from 'effection';
import type { Operation } from 'effection';
import { WindDown, CancelAgent, Pause } from '@lloyal-labs/lloyal-agents';
import { useExecution, OperationFailure } from '../src/execution';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** An operation that runs until halted, and whose teardown waits on `gate`. */
const holding = (gate: Promise<void>, log: string[], name: string) => function* (): Operation<void> {
  log.push(`${name}:start`);
  yield* ensure(function* () { yield* until(gate); log.push(`${name}:torn`); });
  yield* suspend();
};

describe('useExecution', () => {
  it('replace returns before the halt completes; the loop halts, then starts', async () => {
    const log: string[] = [];
    const gate = deferred();
    await run(function* () {
      const exec = yield* useExecution();
      yield* exec.replace('a', holding(gate.promise, log, 'a'));
      yield* sleep(0);
      expect(log).toEqual(['a:start']);

      const fb = yield* exec.replace('b', function* () { log.push('b:start'); });
      // Accepted at once: a's teardown is still waiting on the gate.
      expect(log).toEqual(['a:start']);
      expect(exec.busy).toBe(true);
      expect(exec.current).toBe('b');

      gate.resolve();
      yield* fb;
      expect(log).toEqual(['a:start', 'a:torn', 'b:start']);
      expect(exec.busy).toBe(false);
      expect(exec.current).toBeNull();
    });
  });

  it('stop withdraws an accepted operation that has not started', async () => {
    const log: string[] = [];
    const gate = deferred();
    await run(function* () {
      const exec = yield* useExecution();
      yield* exec.replace('a', holding(gate.promise, log, 'a'));
      yield* sleep(0);
      const fb = yield* exec.replace('b', function* () { log.push('b:start'); });
      yield* exec.stop(); // returns at once, with a's teardown still pending
      expect(exec.busy).toBe(true);
      gate.resolve();
      yield* fb; // withdrawn: settles without ever running
      yield* sleep(0);
      expect(log).toEqual(['a:start', 'a:torn']);
      expect(exec.busy).toBe(false);
      expect(exec.current).toBeNull();
    });
  });

  it('a replace behind another withdraws it — the mailbox never holds two', async () => {
    const log: string[] = [];
    const gate = deferred();
    await run(function* () {
      const exec = yield* useExecution();
      yield* exec.replace('a', holding(gate.promise, log, 'a'));
      yield* sleep(0);
      const fb = yield* exec.replace('b', function* () { log.push('b:start'); });
      const fc = yield* exec.replace('c', function* () { log.push('c:start'); });
      expect(exec.current).toBe('c');
      gate.resolve();
      yield* fb; // withdrawn
      yield* fc;
      expect(log).toEqual(['a:start', 'a:torn', 'c:start']);
    });
  });

  it('an ordinary failure whose cleanup SUCCEEDS does not poison, even when a stop arrives mid-cleanup', async () => {
    await run(function* () {
      const exec = yield* useExecution();
      const gate = deferred();
      const cleaning = deferred();
      const log: string[] = [];
      const bad = yield* exec.replace('bad', function* (): Operation<void> {
        yield* ensure(function* () { cleaning.resolve(); yield* until(gate.promise); log.push('torn:ok'); });
        throw new Error('the planner failed');
      });
      yield* until(cleaning.promise);   // the body has already thrown; its cleanup is in flight
      yield* exec.stop();               // Stop arrives while the model is still settling
      gate.resolve();                   // and the cleanup succeeds
      // How the future settles is the stop's own contract, pinned above; what matters here is that
      // a body failure racing a stop is not read as a teardown failure.
      try { yield* bad; } catch { /* settled either way */ }
      expect(log).toEqual(['torn:ok']);
      expect(exec.poisoned, 'an ordinary body failure was booked as a teardown failure because a stop happened to be in flight').toBe(false);
      // The proof that it is not poisoned: the owner still takes work.
      const after = yield* exec.replace('after', function* () { log.push('after:ran'); yield* sleep(1); });
      yield* after;
      expect(log).toEqual(['torn:ok', 'after:ran']);
    });
  });

  it('a replacement accepted during that cleanup still runs: the previous body error is the operation\'s, not the teardown\'s', async () => {
    await run(function* () {
      const exec = yield* useExecution();
      const gate = deferred();
      const cleaning = deferred();
      const log: string[] = [];
      const bad = yield* exec.replace('bad', function* (): Operation<void> {
        yield* ensure(function* () { cleaning.resolve(); yield* until(gate.promise); log.push('torn:ok'); });
        throw new Error('the planner failed');
      });
      yield* until(cleaning.promise);
      const next = yield* exec.replace('next', function* () { log.push('next:ran'); yield* sleep(1); });
      gate.resolve();
      try { yield* bad; } catch { /* the failed operation's own future */ }
      yield* next;
      expect(log).toEqual(['torn:ok', 'next:ran']);
      expect(exec.poisoned).toBe(false);
    });
  });

  it("an operation that owns its boundary is believed about its own failure: a stop mid-cleanup does not poison", async () => {
    // Field Note's shape: the operation IS a `scoped()`, and its catch sits INSIDE, so it sees only
    // body errors — the cleanups its body registered run after that catch, on the way out. A body
    // error is therefore held inside the boundary while its cleanup runs and reaches the owner only
    // once a halt may have begun. Arrival time cannot tell it from a cleanup failure, so the
    // operation carries the fact: this one was mine.
    await run(function* () {
      const exec = yield* useExecution();
      const gate = deferred();
      const cleaning = deferred();
      const log: string[] = [];
      const bad = yield* exec.replace('bad', () => scoped(function* (): Operation<void> {
        try {
          yield* (function* () {
            yield* ensure(function* () { cleaning.resolve(); yield* until(gate.promise); log.push('torn:ok'); });
            throw new Error('the planner failed');
          })();
        } catch (err) {
          log.push('op:caught');
          throw new OperationFailure(err);   // the body's own, said where it is still known
        }
      }));
      yield* until(cleaning.promise);
      yield* exec.stop();
      gate.resolve();
      try { yield* bad; } catch { /* the stop's contract */ }
      expect(log).toEqual(['op:caught', 'torn:ok']);
      expect(exec.poisoned, 'the operation said the failure was its own and the owner poisoned anyway').toBe(false);
      const after = yield* exec.replace('after', function* () { log.push('after:ran'); yield* sleep(1); });
      yield* after;
      expect(log).toEqual(['op:caught', 'torn:ok', 'after:ran']);
    });
  });

  it("a replacement accepted during a caller-owned boundary's cleanup still starts", async () => {
    await run(function* () {
      const exec = yield* useExecution();
      const gate = deferred();
      const cleaning = deferred();
      const log: string[] = [];
      const bad = yield* exec.replace('bad', () => scoped(function* (): Operation<void> {
        try {
          yield* (function* () {
            yield* ensure(function* () { cleaning.resolve(); yield* until(gate.promise); log.push('torn:ok'); });
            throw new Error('the planner failed');
          })();
        } catch (err) { throw new OperationFailure(err); }
      }));
      yield* until(cleaning.promise);
      const next = yield* exec.replace('next', function* () { log.push('next:ran'); yield* sleep(1); });
      gate.resolve();
      let caught: unknown = null;
      try { yield* bad; } catch (e) { caught = e; }
      yield* next;
      expect((caught as Error).message).toBe('the planner failed');
      expect(log).toEqual(['torn:ok', 'next:ran']);
      expect(exec.poisoned).toBe(false);
    });
  });

  it("an operation that owns its boundary and does NOT say so keeps the fatal reading", async () => {
    // Unmarked during a halt stays the teardown's: a cleanup that failed leaves the model untrustworthy,
    // and the owner has no other way to know.
    await run(function* () {
      const exec = yield* useExecution();
      yield* exec.replace('e', () => scoped(function* () {
        yield* ensure(() => { throw new Error('the branch would not release'); });
        yield* suspend();
      }));
      yield* sleep(0);
      const ff = yield* exec.replace('f', function* () {});
      let caught: unknown = null;
      try { yield* ff; } catch (e) { caught = e; }
      expect((caught as Error).message).toContain('would not release');
      expect(exec.poisoned).toBe(true);
    });
  });

  it('the future resolves on return and rejects on a throw; an ordinary failure does not poison', async () => {
    await run(function* () {
      const exec = yield* useExecution();
      const ok = yield* exec.replace('ok', function* () { yield* sleep(1); });
      yield* ok;
      expect(exec.busy).toBe(false);

      const bad = yield* exec.replace('bad', function* () { throw new Error('the planner failed'); });
      let caught: unknown = null;
      try { yield* bad; } catch (e) { caught = e; }
      expect((caught as Error).message).toBe('the planner failed');
      expect(exec.poisoned).toBe(false);
      expect(exec.busy).toBe(false);

      const again = yield* exec.replace('again', function* () {});
      yield* again;
    });
  });

  it('a halt whose teardown throws poisons the owner', async () => {
    const log: string[] = [];
    await run(function* () {
      const exec = yield* useExecution();
      yield* exec.replace('e', function* () {
        yield* ensure(function* () { throw new Error('teardown failed'); });
        yield* suspend();
      });
      yield* sleep(0);
      const ff = yield* exec.replace('f', function* () { log.push('f:start'); });
      let caught: unknown = null;
      try { yield* ff; } catch (e) { caught = e; }
      expect((caught as Error).message).toContain('teardown failed');
      expect(log).toEqual([]);
      expect(exec.poisoned).toBe(true);
      expect(exec.busy).toBe(false);
      expect(exec.current).toBeNull();

      let refused: unknown = null;
      try { yield* exec.replace('g', function* () {}); } catch (e) { refused = e; }
      expect(refused).toBeInstanceOf(Error);
      let refusedStop: unknown = null;
      try { yield* exec.stop(); } catch (e) { refusedStop = e; }
      expect(refusedStop).toBeInstanceOf(Error);
    });
  });

  it("a cleanup failing inside the operation's boundary during the halt poisons the owner, through the operation's own catch", async () => {
    const log: string[] = [];
    await run(function* () {
      const exec = yield* useExecution();
      yield* exec.replace('e', function* () {
        try {
          yield* scoped(function* () {
            yield* ensure(() => { throw new Error('the branch would not release'); });
            yield* suspend();
          });
        } catch (err) {
          log.push(`caught:${(err as Error).message}`);   // the operation reports and rethrows, as a harness does
          throw err;
        }
      });
      yield* sleep(0);
      const ff = yield* exec.replace('f', function* () { log.push('f:start'); });
      let caught: unknown = null;
      try { yield* ff; } catch (e) { caught = e; }
      expect((caught as Error).message).toContain('would not release');
      expect(log).toEqual(['caught:the branch would not release']);
      expect(exec.poisoned).toBe(true);
    });
  });

  it("an ordinary failure raised while nothing is halting does not poison, even a child's at the operation's boundary", async () => {
    await run(function* () {
      const exec = yield* useExecution();
      const fe = yield* exec.replace('e', () => scoped(function* () {
        yield* spawn(function* () { throw new Error('a child failed'); });
        yield* suspend();
      }));
      let caught: unknown = null;
      try { yield* fe; } catch (e) { caught = e; }
      expect((caught as Error).message).toBe('a child failed');
      expect(exec.poisoned).toBe(false);
      expect(exec.busy).toBe(false);
    });
  });

  it('busy holds until the halt completes; a run that ends on its own frees the owner', async () => {
    const gate = deferred();
    const log: string[] = [];
    await run(function* () {
      const exec = yield* useExecution();
      expect(exec.busy).toBe(false);
      expect(exec.current).toBeNull();
      const fa = yield* exec.replace('a', holding(gate.promise, log, 'a'));
      yield* sleep(0);
      expect(exec.busy).toBe(true);
      yield* exec.stop();
      expect(exec.busy).toBe(true); // the halt has not completed
      gate.resolve();
      yield* fa; // the stopped operation's future settles once its halt completed
      expect(exec.busy).toBe(false);

      const done = yield* exec.replace('d', function* () {});
      yield* done;
      expect(exec.busy).toBe(false);
      expect(exec.current).toBeNull();
    });
  });

  it('the controls send the ambient signals only while an operation runs, and reset per operation', async () => {
    const sent: string[] = [];
    const gate = deferred();
    await run(function* () {
      const windDown = createSignal<void, void>();
      const cancel = createSignal<{ agentId: number }, void>();
      const pause = createSignal<boolean, void>();
      yield* WindDown.set(windDown);
      yield* CancelAgent.set(cancel);
      yield* Pause.set(pause);
      yield* spawn(function* () { for (const _ of yield* each(windDown)) { sent.push('windDown'); yield* each.next(); } });
      yield* spawn(function* () { for (const c of yield* each(cancel)) { sent.push(`cancel:${c.agentId}`); yield* each.next(); } });
      yield* spawn(function* () { for (const p of yield* each(pause)) { sent.push(`pause:${p}`); yield* each.next(); } });
      const exec = yield* useExecution();

      // Idle: nothing runs, nothing is sent.
      exec.pause(); exec.resume(); exec.wrapUp(); exec.cancel(7);
      yield* sleep(0);
      expect(sent).toEqual([]);

      yield* exec.replace('a', holding(gate.promise, [], 'a'));
      yield* sleep(0);
      exec.resume();                // not paused: nothing
      exec.pause(); exec.pause();   // once
      exec.wrapUp();                // refused while paused
      exec.resume(); exec.resume(); // once
      exec.cancel(7);
      exec.wrapUp(); exec.wrapUp(); // once
      exec.pause();                 // refused while winding down
      yield* sleep(0);
      expect(sent).toEqual(['pause:true', 'pause:false', 'cancel:7', 'windDown']);

      // A replacement starts clean: paused and winding down are the operation's.
      sent.length = 0;
      const fb = yield* exec.replace('b', function* () { yield* suspend(); });
      gate.resolve();
      yield* sleep(0); yield* sleep(0);
      exec.wrapUp();
      yield* sleep(0);
      expect(sent).toEqual(['windDown']);
      yield* exec.stop();
      yield* fb;
    });
  });

  // The owner's docblock promises that a replacement waits for the previous operation's
  // teardown — "every `ensure`, `waitUntilSettled`'s settle barrier included" — before it
  // touches the model. The halt path keeps that promise. These two pin it for the operation
  // that simply RETURNS, which is the path an ordinary `ensure` takes.
  it('the accepted future settles only after the operation\'s own cleanup has run', async () => {
    const order: string[] = [];
    await run(function* () {
      const exec = yield* useExecution();
      const a = yield* exec.replace('a', function* () {
        yield* ensure(function* () { order.push('cleanup:start'); yield* sleep(20); order.push('cleanup:end'); });
        order.push('body:return');
      });
      yield* a;
      order.push(`awaited:busy=${exec.busy}`);
      yield* sleep(60);
    });
    expect(order).toEqual(['body:return', 'cleanup:start', 'cleanup:end', 'awaited:busy=false']);
  });

  it('a replacement starts only after the returned operation has finished cleaning up', async () => {
    const order: string[] = [];
    await run(function* () {
      const exec = yield* useExecution();
      const a = yield* exec.replace('a', function* () {
        yield* ensure(function* () { order.push('a:cleanup:start'); yield* sleep(20); order.push('a:cleanup:end'); });
        order.push('a:return');
      });
      yield* a;
      yield* exec.replace('b', function* () { order.push('b:start'); });
      yield* sleep(80);
    });
    expect(order.indexOf('b:start')).toBeGreaterThan(order.indexOf('a:cleanup:end'));
  });

  it('without the signals in context the controls are no-ops', async () => {
    await run(function* () {
      const exec = yield* useExecution();
      yield* exec.replace('a', function* () { yield* suspend(); });
      yield* sleep(0);
      expect(() => { exec.pause(); exec.resume(); exec.wrapUp(); exec.cancel(1); }).not.toThrow();
      yield* exec.stop();
    });
  });
});
