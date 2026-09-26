/**
 * Ownership begins with the request: whatever a scope asks for is disposed by that scope, and the scope does
 * not leave until it knows what it asked for — a halt during a creation waits for the creation to settle.
 */
import { describe, it, expect } from 'vitest';
import { ensure, run, scoped, sleep, spawn } from 'effection';
import { acquire } from '../src/acquire';

describe('acquire', () => {
  it('a halt while the creation is pending waits for it, then disposes it exactly once; the value is never returned', async () => {
    let resolve!: (v: string) => void;
    const disposed: string[] = [];
    let returned: string | undefined;
    let halted = false;
    await run(function* () {
      const task = yield* spawn(function* () {
        returned = yield* acquire(() => new Promise<string>((r) => { resolve = r; }), (v) => { disposed.push(v); });
      });
      yield* sleep(0);
      const halting = yield* spawn(function* () { yield* task.halt(); halted = true; });
      yield* sleep(0);
      expect(halted).toBe(false);      // the scope is still there: the creation has not settled
      expect(disposed).toEqual([]);
      resolve('ctx');
      yield* halting;
    });
    expect(halted).toBe(true);
    expect(disposed).toEqual(['ctx']);
    expect(returned).toBeUndefined();
  });

  it('on the normal path the value is returned, and disposed once when the scope exits', async () => {
    const disposed: string[] = [];
    let seen: string | undefined;
    await run(function* () {
      yield* scoped(function* () {
        seen = yield* acquire(() => Promise.resolve('ctx'), (v) => { disposed.push(v); });
        expect(disposed).toEqual([]);
      });
      expect(disposed).toEqual(['ctx']);
    });
    expect(seen).toBe('ctx');
  });

  it('a rejection is thrown and nothing is disposed', async () => {
    const disposed: string[] = [];
    await expect(run(function* () {
      yield* acquire(() => Promise.reject(new Error('no such file')), (v: string) => { disposed.push(v); });
    })).rejects.toThrow('no such file');
    expect(disposed).toEqual([]);
  });

  it('a dispose that throws never stops the scope from closing', async () => {
    let closed = false;
    await run(function* () {
      yield* scoped(function* () {
        yield* acquire(() => Promise.resolve('ctx'), () => { throw new Error('double free'); });
      });
      closed = true;
    });
    expect(closed).toBe(true);
  });

  it('a creation built in stages is two acquisitions: a halt while the second stage runs on the first frees nothing until it settles, then the second, then the first', async () => {
    // The reranker's shape: a context, then a composition whose canary runs on it. A context freed under
    // its own canary is the finding this row holds.
    let finish!: () => void;
    const order: string[] = [];
    await run(function* () {
      const task = yield* spawn(function* () {
        const first = yield* acquire(() => Promise.resolve('ctx'), (v) => { order.push(`free(${v})`); });
        yield* acquire(
          () => new Promise<string>((r) => { finish = () => { order.push(`stage-2-end(${first})`); r('rerank'); }; }),
          (v) => { order.push(`free(${v})`); },
        );
      });
      yield* sleep(0);
      const halting = yield* spawn(function* () { yield* task.halt(); });
      yield* sleep(0);
      expect(order).toEqual([]);
      finish();
      yield* halting;
    });
    expect(order).toEqual(['stage-2-end(ctx)', 'free(rerank)', 'free(ctx)']);
  });

  it('a teardown registered after the acquisition runs before the free — the drain precedes the release', async () => {
    const order: string[] = [];
    await run(function* () {
      yield* scoped(function* () {
        yield* acquire(() => Promise.resolve('ctx'), () => { order.push('free'); });
        yield* ensure(() => { order.push('drain'); });
      });
    });
    expect(order).toEqual(['drain', 'free']);
  });
});
