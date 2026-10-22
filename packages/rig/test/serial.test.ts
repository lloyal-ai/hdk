/**
 * The serial executor a provider's native work runs through: one call at a
 * time, in order; a caller that leaves while queued gives up its place; and the
 * scope that owns it ends only once the running call has, refusing new work.
 */
import { describe, it, expect } from 'vitest';
import { createScope, run, sleep, spawn, suspend, withResolvers } from 'effection';
import { useSerialExecutor } from '../src/providers/serial';
import type { SerialExecutor } from '../src/providers/serial';

describe('useSerialExecutor', () => {
  it('runs one call at a time, in the order they arrived', async () => {
    const log: string[] = [];
    await run(function* () {
      const serial = yield* useSerialExecutor();
      const task = (name: string) => serial.run(function* () { log.push(`${name}:start`); yield* sleep(5); log.push(`${name}:end`); });
      const a = yield* spawn(() => task('a'));
      const b = yield* spawn(() => task('b'));
      yield* a;
      yield* b;
    });
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('a caller that leaves while queued gives up its place and never runs', async () => {
    const log: string[] = [];
    await run(function* () {
      const serial = yield* useSerialExecutor();
      const running = withResolvers<void>();
      const first = yield* spawn(() => serial.run(function* () { log.push('first'); yield* running.operation; }));
      yield* sleep(0);
      const queued = yield* spawn(() => serial.run(function* () { log.push('queued'); }));
      yield* sleep(0);
      yield* queued.halt();
      const after = yield* spawn(() => serial.run(function* () { log.push('after'); }));
      running.resolve();
      yield* first;
      yield* after;
    });
    expect(log).toEqual(['first', 'after']);
  });

  it('the owning scope ends only once a caller\'s running call has, and refuses work after', async () => {
    const log: string[] = [];
    const [scope, destroy] = createScope();
    // The executor lives as long as the task that owns it, which stays until the scope is destroyed.
    const serial = await new Promise<SerialExecutor>((resolve) => {
      scope.run(function* () { resolve(yield* useSerialExecutor()); yield* suspend(); });
    });
    const release = withResolvers<void>();
    // The caller is not the owner: its call runs in a scope of its own, as a run's does against a service's.
    const call = run(() => serial.run(function* () { yield* release.operation; log.push('ran'); }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const ended = destroy().then(() => log.push('ended'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(log).toEqual([]);
    release.resolve();
    await Promise.all([call, ended]);
    expect(log).toEqual(['ran', 'ended']);
    await expect(run(() => serial.run(function* () { yield* suspend(); }))).rejects.toThrow(/disposed/);
  });
});
