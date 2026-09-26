/**
 * A renderer that subscribes late is told what it missed FIRST — the retained frames — then the live stream, in
 * order, whatever the timing of the two arrivals. The mechanism is transport-free, so the preload's use of it over
 * IPC is one line.
 */
import { describe, it, expect } from 'vitest';
import { subscribeSeeded } from '../src/seeded-subscription';

type F = { seq: number };

function harness() {
  let live: ((f: F) => void) | null = null;
  let resolveSeed: ((f: F[]) => void) | null = null;
  let rejectSeed: ((e: Error) => void) | null = null;
  let offCalls = 0;
  const source = {
    live: (cb: (f: F) => void) => { live = cb; return () => { live = null; offCalls += 1; }; },
    seed: () => new Promise<F[]>((res, rej) => { resolveSeed = res; rejectSeed = rej; }),
  };
  return {
    source,
    push: (f: F) => live?.(f),
    seed: (fs: F[]) => resolveSeed?.(fs),
    failSeed: () => rejectSeed?.(new Error('no handler')),
    get offCalls() { return offCalls; },
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('subscribeSeeded', () => {
  it('delivers the seed before live frames that arrived while the seed was in flight, then live directly', async () => {
    const h = harness();
    const seen: number[] = [];
    subscribeSeeded(h.source, (f) => seen.push(f.seq));
    h.push({ seq: 5 });
    h.push({ seq: 6 });
    expect(seen).toEqual([]);           // held until the seed says what came before
    h.seed([{ seq: 2 }, { seq: 4 }]);
    await flush();
    expect(seen).toEqual([2, 4, 5, 6]);
    h.push({ seq: 7 });
    expect(seen).toEqual([2, 4, 5, 6, 7]);
  });

  it('a seed that cannot be had is an empty seed: the live stream still flows', async () => {
    const h = harness();
    const seen: number[] = [];
    subscribeSeeded(h.source, (f) => seen.push(f.seq));
    h.push({ seq: 1 });
    h.failSeed();
    await flush();
    expect(seen).toEqual([1]);
    h.push({ seq: 2 });
    expect(seen).toEqual([1, 2]);
  });

  it('unsubscribing before the seed arrives delivers nothing afterwards, and releases the live subscription', async () => {
    const h = harness();
    const seen: number[] = [];
    const off = subscribeSeeded(h.source, (f) => seen.push(f.seq));
    h.push({ seq: 1 });
    off();
    h.seed([{ seq: 0 }]);
    await flush();
    expect(seen).toEqual([]);
    expect(h.offCalls).toBe(1);
  });
});
