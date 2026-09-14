/**
 * The projection over a bridge: subscribe first, buffer until the snapshot
 * lands, seed by `seq`, fold what came after; a frame at or below the seen
 * `seq` is a replay and is dropped; an unreachable snapshot seeds from the
 * initial state; a frame from another epoch reseeds; a snapshot that lands
 * after disposal is discarded. The same laws hold over a wss-shaped bridge
 * (frames and snapshot asynchronous) and an IPC-shaped one (frames relayed
 * synchronously, the snapshot answered from the main process's own fold).
 */
import { describe, it, expect } from 'vitest';
import { connectProjection } from '../src/projection';
import type { Bridge, Frame, Snapshot } from '../src/projection';

type Ev = { type: 'n'; n: number } | { type: 'reset' };
type S = { sum: number; seen: number[] };
const initial: S = { sum: 0, seen: [] };
const reduce = (s: S, ev: Ev): S => ev.type === 'reset' ? initial : { sum: s.sum + ev.n, seen: [...s.seen, ev.n] };

/** A bridge a test drives by hand: it folds its own snapshot like the web bridge and the desktop main do. */
function fakeBridge(opts: { asyncSnapshot: boolean; answer?: boolean }) {
  const subs = new Set<(f: Frame<Ev>) => void>();
  let epoch = 1;
  let seq = 0;
  let state = initial;
  let snapshots = 0;
  const bridge: Bridge<Ev, never, S> = {
    onEvent(cb) { subs.add(cb); return () => subs.delete(cb); },
    send() {},
    requestSnapshot() {
      snapshots++;
      if (opts.answer === false) return Promise.reject(new Error('no snapshot on this bridge'));
      const snap: Snapshot<S> = { state, epoch, seq };
      return opts.asyncSnapshot ? new Promise((r) => setTimeout(() => r(snap), 5)) : Promise.resolve(snap);
    },
  };
  return {
    bridge,
    /** Deliver one event: the bridge folds it, numbers it, and hands the frame to every subscriber. */
    emit(ev: Ev) {
      seq += 1;
      state = reduce(state, ev);
      const frame = { epoch, seq, ev };
      for (const cb of subs) cb(frame);
    },
    /** Hand a frame to every subscriber as it is — a replay of history, a stale delivery. */
    deliver(frame: Frame<Ev>) { for (const cb of subs) cb(frame); },
    /** A new stream behind the same bridge — a reconnect, a restarted engine. */
    newEpoch() { epoch += 1; seq = 0; state = initial; },
    get snapshots() { return snapshots; },
    get subscribers() { return subs.size; },
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 12));

describe.each([
  ['a wss-shaped bridge (asynchronous snapshot)', true],
  ['an IPC-shaped bridge (the snapshot answered at once)', false],
])('connectProjection over %s', (_name, asyncSnapshot) => {
  it('subscribes first, buffers until the snapshot lands, and folds only what came after the cut', async () => {
    const b = fakeBridge({ asyncSnapshot });
    b.emit({ type: 'n', n: 1 });
    b.emit({ type: 'n', n: 2 });
    const p = connectProjection(b.bridge, initial, reduce);
    expect(b.subscribers).toBe(1);
    // Frames between the subscription and the snapshot's arrival are buffered, not lost and not double-folded.
    b.emit({ type: 'n', n: 3 });
    await tick();
    expect(p.getSnapshot()).toEqual({ sum: 6, seen: [1, 2, 3] });
    b.emit({ type: 'n', n: 4 });
    expect(p.getSnapshot()).toEqual({ sum: 10, seen: [1, 2, 3, 4] });
  });

  it('a frame at or below the seen seq is a replay and is dropped', async () => {
    const b = fakeBridge({ asyncSnapshot });
    const p = connectProjection(b.bridge, initial, reduce);
    await tick();
    b.emit({ type: 'n', n: 1 });
    b.emit({ type: 'n', n: 2 });
    const before = p.getSnapshot();
    // A second delivery of frame 1, as a bridge that replays its history would send: dropped, no fold, no notify.
    const seen: S[] = [];
    p.subscribe((s) => seen.push(s));
    b.deliver({ epoch: 1, seq: 1, ev: { type: 'n', n: 100 } });
    expect(p.getSnapshot()).toBe(before);
    expect(seen).toEqual([]);
  });

  it('an unreachable snapshot seeds from the initial state and folds what arrived since subscribing', async () => {
    const b = fakeBridge({ asyncSnapshot, answer: false });
    b.emit({ type: 'n', n: 1 });   // before the subscription: only a snapshot could have carried it
    const p = connectProjection(b.bridge, initial, reduce);
    b.emit({ type: 'n', n: 2 });
    await tick();
    expect(p.getSnapshot()).toEqual({ sum: 2, seen: [2] });
    b.emit({ type: 'n', n: 3 });
    expect(p.getSnapshot()).toEqual({ sum: 5, seen: [2, 3] });
  });

  it('a frame from another epoch reseeds from the new stream instead of mixing two', async () => {
    const b = fakeBridge({ asyncSnapshot });
    const p = connectProjection(b.bridge, initial, reduce);
    await tick();
    b.emit({ type: 'n', n: 5 });
    expect(p.getSnapshot().sum).toBe(5);
    b.newEpoch();
    b.emit({ type: 'n', n: 1 });
    b.emit({ type: 'n', n: 2 });
    await tick();
    expect(p.getSnapshot()).toEqual({ sum: 3, seen: [1, 2] });
    expect(b.snapshots).toBe(2);
  });

  it('a snapshot that lands after disposal is discarded, and no frame reaches a disposed projection', async () => {
    const b = fakeBridge({ asyncSnapshot: true });
    const p = connectProjection(b.bridge, initial, reduce);
    const seen: S[] = [];
    p.subscribe((s) => seen.push(s));
    p.dispose();
    b.emit({ type: 'n', n: 9 });
    await tick();
    expect(p.getSnapshot()).toBe(initial);
    expect(seen).toEqual([]);
    expect(b.subscribers).toBe(0);
  });

  it('notifies once per fold with the folded state, and getSnapshot keeps one reference between folds', async () => {
    const b = fakeBridge({ asyncSnapshot });
    const p = connectProjection(b.bridge, initial, reduce);
    await tick();
    const seen: S[] = [];
    p.subscribe((s) => seen.push(s));
    b.emit({ type: 'n', n: 1 });
    b.emit({ type: 'n', n: 2 });
    expect(seen.map((s) => s.sum)).toEqual([1, 3]);
    expect(p.getSnapshot()).toBe(seen[1]);
    expect(p.getSnapshot()).toBe(p.getSnapshot());
  });
});
