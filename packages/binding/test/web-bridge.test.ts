/**
 * The browser bridge owns a fold. A subscriber that arrives after frames were
 * delivered seeds from the bridge's snapshot — the folded state as of the last
 * frame — and folds only what comes after: a remount past any history cap is
 * a snapshot, not a replay. Commands queue until the host's `ready`; the
 * socket closing reads as `lost`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBridge } from '../src/web';
import { connectProjection } from '../src/projection';

type Ev = { type: 'n'; n: number };
type S = { sum: number; count: number };
const reduce = (s: S, ev: Ev): S => ({ sum: s.sum + ev.n, count: s.count + 1 });

/** A WebSocket the test drives: it records sends and lets the test inject server frames. */
class FakeSocket {
  static last: FakeSocket | null = null;
  sent: string[] = [];
  closed = false;
  private handlers: Record<string, ((ev: { data: unknown }) => void)[]> = {};
  constructor(public url: string) { FakeSocket.last = this; }
  addEventListener(type: string, listener: (ev: { data: unknown }) => void): void {
    (this.handlers[type] ??= []).push(listener);
  }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.serverClose(); }
  serverFrame(frame: unknown): void {
    for (const h of this.handlers['message'] ?? []) h({ data: JSON.stringify({ sessionId: 's1', frame }) });
  }
  serverClose(): void {
    for (const h of this.handlers['close'] ?? []) (h as unknown as () => void)();
  }
}

const g = globalThis as unknown as { WebSocket?: unknown };
let saved: unknown;
beforeEach(() => { saved = g.WebSocket; g.WebSocket = FakeSocket; });
afterEach(() => { g.WebSocket = saved; });

const tick = () => new Promise<void>((r) => setTimeout(r, 5));

describe('createBridge', () => {
  it('a late subscriber seeds from the folded snapshot and folds only what comes after', async () => {
    const bridge = createBridge<Ev, { type: 'x' }, S>('ws://h', { initialState: { sum: 0, count: 0 }, reduce });
    const ws = FakeSocket.last!;
    ws.serverFrame({ t: 'ready' });
    for (let i = 1; i <= 3; i++) ws.serverFrame({ t: 'event', payload: { type: 'n', n: i } });
    // Nothing subscribed yet: the frames are folded, not kept.
    const p = connectProjection(bridge, { sum: 0, count: 0 }, reduce);
    await tick();
    expect(p.getSnapshot()).toEqual({ sum: 6, count: 3 });
    ws.serverFrame({ t: 'event', payload: { type: 'n', n: 4 } });
    expect(p.getSnapshot()).toEqual({ sum: 10, count: 4 });
    // And a second view, mounted later still, agrees with the first.
    const q = connectProjection(bridge, { sum: 0, count: 0 }, reduce);
    await tick();
    expect(q.getSnapshot()).toEqual(p.getSnapshot());
  });

  it("commands queue until the host says ready, then go in order; status reads connecting → connected → lost", () => {
    const bridge = createBridge<Ev, { type: 'x'; i: number }, S>('ws://h', { initialState: { sum: 0, count: 0 }, reduce });
    const ws = FakeSocket.last!;
    const statuses: string[] = [];
    bridge.onStatus!((s) => statuses.push(s));
    bridge.send({ type: 'x', i: 1 });
    bridge.send({ type: 'x', i: 2 });
    expect(ws.sent).toEqual([]);
    ws.serverFrame({ t: 'ready' });
    expect(ws.sent.map((f) => (JSON.parse(f) as { frame: { payload: { i: number } } }).frame.payload.i)).toEqual([1, 2]);
    bridge.send({ type: 'x', i: 3 });
    expect(ws.sent).toHaveLength(3);
    ws.serverClose();
    expect(statuses).toEqual(['connecting', 'connected', 'lost']);
  });

  it('the content origin is the one given, and absent when none was', () => {
    const with_ = createBridge<Ev, never, S>('ws://h', { initialState: { sum: 0, count: 0 }, reduce, contentOrigin: '' });
    expect(with_.contentOrigin?.()).toBe('');
    const without = createBridge<Ev, never, S>('ws://h', { initialState: { sum: 0, count: 0 }, reduce });
    expect(without.contentOrigin).toBeUndefined();
  });
});
