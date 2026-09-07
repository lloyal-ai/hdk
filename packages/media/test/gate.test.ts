/**
 * The permit gate — the process-wide bound on decoded content in memory.
 *
 * One construct, extracted from the image normalizer so a document ingest can
 * hold a permit of the SAME gate for its whole duration: images and documents
 * together never exceed the permit count. These cases pin the gate's own
 * contract; the normalizer's suite pins that the normalizer still stands
 * behind it.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import { createGate, gate, MAX_CONCURRENT_NORMALIZATIONS, MAX_QUEUED_NORMALIZATIONS } from '../src/gate';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createGate', () => {
  it('bounds concurrency to its permits and hands a freed permit to the next waiter', async () => {
    const g = createGate({ label: 'test', permits: 2, maxQueued: 4, waitMs: 1_000 });
    const r1 = await g.acquire();
    const r2 = await g.acquire();
    let third = false;
    const p3 = g.acquire().then((r) => { third = true; return r; });
    await tick();
    expect(third).toBe(false);
    r1();
    const r3 = await p3;
    expect(third).toBe(true);
    r2(); r3();
  });

  it('refuses immediately with EBUSY once the queue is full', async () => {
    const g = createGate({ label: 'test', permits: 1, maxQueued: 1, waitMs: 1_000 });
    const r1 = await g.acquire();
    const queued = g.acquire();
    await expect(g.acquire()).rejects.toMatchObject({ code: 'EBUSY' });
    r1();
    (await queued)();
  });

  it('lets a queued caller give up before any slot frees, and refuses an already-aborted one', async () => {
    const g = createGate({ label: 'test', permits: 1, maxQueued: 4, waitMs: 1_000 });
    const r1 = await g.acquire();
    const ctrl = new AbortController();
    const queued = g.acquire(ctrl.signal);
    ctrl.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await expect(g.acquire(AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
    r1();
    // The gate is intact afterwards.
    (await g.acquire())();
  });

  it('times out a waiter and names the wait', async () => {
    const g = createGate({ label: 'test', permits: 1, maxQueued: 4, waitMs: 20 });
    const r1 = await g.acquire();
    await expect(g.acquire()).rejects.toThrow(/waited 20ms/);
    r1();
  });

  it('makes release idempotent so a double release cannot manufacture a permit', async () => {
    const g = createGate({ label: 'test', permits: 1, maxQueued: 4, waitMs: 1_000 });
    const r1 = await g.acquire();
    r1(); r1();
    const r2 = await g.acquire();
    let third = false;
    const p3 = g.acquire().then((r) => { third = true; return r; });
    await tick();
    expect(third).toBe(false);
    r2();
    (await p3)();
  });
});

describe('the shared gate', () => {
  it('is one instance sized by the normalizer constants', () => {
    expect(typeof gate.acquire).toBe('function');
    expect(MAX_CONCURRENT_NORMALIZATIONS).toBe(4);
    expect(MAX_QUEUED_NORMALIZATIONS).toBe(16);
  });
});
