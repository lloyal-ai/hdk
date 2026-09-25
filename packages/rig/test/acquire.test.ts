/**
 * Ownership begins with the request: whatever a scope asks for is disposed by that scope, even a value that
 * arrives after the scope has left.
 */
import { describe, it, expect } from 'vitest';
import { ensure, run, scoped, sleep, spawn } from 'effection';
import { acquire } from '../src/acquire';

describe('acquire', () => {
  it('a creation still pending when the scope halts is disposed on arrival, exactly once, and never returned', async () => {
    let resolve!: (v: string) => void;
    const disposed: string[] = [];
    let returned: string | undefined;
    await run(function* () {
      const task = yield* spawn(function* () {
        returned = yield* acquire(() => new Promise<string>((r) => { resolve = r; }), (v) => { disposed.push(v); });
      });
      yield* sleep(0);
      yield* task.halt();
    });
    expect(disposed).toEqual([]);
    resolve('ctx');
    await new Promise((r) => setTimeout(r, 0));
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
