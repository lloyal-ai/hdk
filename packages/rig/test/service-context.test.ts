/**
 * The native context a service owns: created and freed with its scope, used one unit of work at a time, and freed
 * only once the unit running has finished. No unit starts once the owning scope has begun ending, so none starts on a
 * context being freed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createScope, run, sleep, spawn, suspend, withResolvers } from 'effection';
import { MockSessionContext } from '../../sdk/src/testing';
import { useServiceContext } from '../src/providers/service-context';
import type { ServiceContext } from '../src/providers/service-context';

const { createContext } = vi.hoisted(() => ({ createContext: vi.fn() }));
vi.mock('@lloyal-labs/sdk/node', () => ({ createContext }));

const log: string[] = [];
let ctx: MockSessionContext;

beforeEach(() => {
  log.length = 0;
  ctx = new MockSessionContext();
  const dispose = ctx.dispose.bind(ctx);
  vi.spyOn(ctx, 'dispose').mockImplementation(() => { log.push('freed'); return dispose(); });
  createContext.mockReset();
  createContext.mockResolvedValue(ctx);
});

describe('useServiceContext', () => {
  it('creates the context it is given options for, and frees it with the scope', async () => {
    await run(function* () {
      const service = yield* useServiceContext({ modelPath: '/m.gguf', nSeqMax: 1 });
      expect(yield* service.run(function* (c) { return c; })).toBe(ctx);
    });
    expect(createContext).toHaveBeenCalledWith({ modelPath: '/m.gguf', nSeqMax: 1 });
    expect(log).toEqual(['freed']);
  });

  it('runs one unit at a time, in the order they arrived', async () => {
    await run(function* () {
      const service = yield* useServiceContext({ modelPath: '/m.gguf' });
      const unit = (name: string) => service.run(function* () { log.push(`${name}:start`); yield* sleep(5); log.push(`${name}:end`); });
      const a = yield* spawn(() => unit('a'));
      const b = yield* spawn(() => unit('b'));
      yield* a;
      yield* b;
    });
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'freed']);
  });

  it('a caller that leaves while queued gives up its place and never runs', async () => {
    await run(function* () {
      const service = yield* useServiceContext({ modelPath: '/m.gguf' });
      const running = withResolvers<void>();
      const first = yield* spawn(() => service.run(function* () { log.push('first'); yield* running.operation; }));
      yield* sleep(0);
      const queued = yield* spawn(() => service.run(function* () { log.push('queued'); }));
      yield* sleep(0);
      yield* queued.halt();
      running.resolve();
      yield* first;
    });
    expect(log).toEqual(['first', 'freed']);
  });

  it('the owning scope frees the context only once a caller\'s running unit has finished', async () => {
    const [scope, destroy] = createScope();
    // The service lives as long as the task that owns it, which stays until the scope is destroyed.
    const service = await new Promise<ServiceContext>((resolve) => {
      scope.run(function* () { resolve(yield* useServiceContext({ modelPath: '/m.gguf' })); yield* suspend(); });
    });
    const release = withResolvers<void>();
    // The caller is not the owner: its unit runs in a scope of its own, as a run's does against a service's.
    const running = run(() => service.run(function* () { yield* release.operation; log.push('ran'); }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const ended = destroy().then(() => log.push('ended'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(log).toEqual([]);
    release.resolve();
    await Promise.all([running, ended]);
    expect(log).toEqual(['ran', 'freed', 'ended']);
  });

  it('once the owning scope has begun ending, a caller\'s unit that reaches its turn is refused and never starts', async () => {
    const [scope, destroy] = createScope();
    const service = await new Promise<ServiceContext>((resolve) => {
      scope.run(function* () { resolve(yield* useServiceContext({ modelPath: '/m.gguf' })); yield* suspend(); });
    });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const release = withResolvers<void>();
    // Callers that are not the owner, so its ending halts none of them: one running, one queued before the end began
    // and one arriving after it.
    const first = run(() => service.run(function* () { log.push('first:start'); yield* release.operation; log.push('first:end'); }));
    await tick();
    const queued = run(() => service.run(function* () { log.push('queued'); }));
    await tick();
    const ended = destroy().then(() => log.push('ended'));
    await tick();
    const late = run(() => service.run(function* () { log.push('late'); }));
    await tick();
    release.resolve();
    const settled = await Promise.allSettled([first, queued, late, ended]);
    expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'rejected', 'rejected', 'fulfilled']);
    expect(log).toEqual(['first:start', 'first:end', 'freed', 'ended']);
  });

  it('a caller granted its turn just as the owning scope ends still gives it back, so the scope ends', async () => {
    const ended = run(function* () {
      const service = yield* useServiceContext({ modelPath: '/m.gguf' });
      const running = withResolvers<void>();
      const first = yield* spawn(() => service.run(function* () { yield* running.operation; }));
      yield* sleep(0);
      // Queued behind the first; the scope ends the turn the first finishes, as it is granted its turn.
      yield* spawn(() => service.run(function* () {}));
      yield* sleep(0);
      running.resolve();
      yield* first;
    }).then(() => 'ended');
    const stuck = new Promise((resolve) => setTimeout(() => resolve('stuck'), 500));
    expect(await Promise.race([ended, stuck])).toBe('ended');
  });
});
