/**
 * What the view is told about whether its harness can take work.
 *
 * Two facts, one answer. The transport says whether the socket is up; the host
 * says what became of the session. A reader queued behind other users has a
 * healthy socket and no harness, and a reader whose session ended sees a close
 * that — read alone — is just a network failure. So the hook derives from both,
 * and holds no vocabulary of its own.
 *
 * Driven on a CLIENT render (Ink, the workspace's React renderer for a
 * terminal), because `useSyncExternalStore`'s subscription is the subject and a
 * server render never subscribes.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { Writable } from 'node:stream';
import { render, Text } from 'ink';
import type { Availability, Bridge, SessionState, WireStatus } from '@lloyal-labs/binding';
import { HarnessProvider, useAvailability, useRecover } from '../src/provider';

type Ev = { type: 'n'; n: number };
type S = { sum: number };
const reduce = (s: S, ev: Ev): S => ({ sum: s.sum + ev.n });

/** A served bridge: both planes, each reporting its current value on subscribe. */
function servedBridge(): Bridge<Ev, never, S> & {
  wire(status: WireStatus): void;
  host(state: SessionState): void;
} {
  let status: WireStatus = 'connecting';
  let session: SessionState | null = null;
  const wires = new Set<(s: WireStatus) => void>();
  const hosts = new Set<(s: SessionState) => void>();
  return {
    onEvent: () => () => {},
    send: () => {},
    requestSnapshot: () => Promise.resolve({ state: { sum: 0 }, epoch: 1, seq: 0 }),
    onStatus(cb) { wires.add(cb); cb(status); return () => { wires.delete(cb); }; },
    onSession(cb) { hosts.add(cb); if (session) cb(session); return () => { hosts.delete(cb); }; },
    wire(next) { status = next; for (const cb of wires) cb(next); },
    host(next) { session = next; for (const cb of hosts) cb(next); },
  };
}

/** A bridge with neither plane: no droppable link, and nothing reporting a session's phases. */
function inProcessBridge(): Bridge<Ev, never, S> {
  return {
    onEvent: () => () => {},
    send: () => {},
    requestSnapshot: () => Promise.resolve({ state: { sum: 0 }, epoch: 1, seq: 0 }),
  };
}

function sink(): NodeJS.WriteStream {
  const stream = new Writable({ write(_chunk, _encoding, done) { done(); } });
  return Object.assign(stream, { columns: 80, rows: 24 }) as unknown as NodeJS.WriteStream;
}

function watch(bridge: Bridge<Ev, never, S>) {
  const seen: Availability[] = [];
  function View() {
    const a = useAvailability();
    seen.push(a);
    return createElement(Text, null, a);
  }
  const app = render(
    createElement(HarnessProvider<Ev, never, S>, { bridge, initialState: { sum: 0 }, reduce, children: createElement(View) }),
    { stdout: sink(), patchConsole: false, exitOnCtrlC: false, interactive: false },
  );
  return { seen, app, runs: () => seen.filter((s, i) => s !== seen[i - 1]) };
}

const painted = (): Promise<void> => new Promise((r) => setTimeout(r, 80));

describe('useAvailability', () => {
  it('a reader waiting behind other users is told so, though the socket is perfectly healthy', async () => {
    const bridge = servedBridge();
    const w = watch(bridge);
    await painted();
    // `wss()` routes `ready` at bind time, before the host admits: connected, and nothing running.
    bridge.wire('connected');
    bridge.host({ phase: 'queued', position: 2 });
    await painted();
    bridge.host({ phase: 'warming' });
    await painted();
    bridge.host({ phase: 'live' });
    await painted();
    w.app.unmount();
    expect(w.runs()).toEqual(['connecting', 'queued', 'warming', 'ready']);
  });

  it('a session that ends reads as ended, and the close that follows does not rewrite it', async () => {
    const bridge = servedBridge();
    const w = watch(bridge);
    bridge.wire('connected');
    bridge.host({ phase: 'live' });
    await painted();
    // The producer announces, then closes. If the close won, every ended session would read as a
    // network failure — wrong, and it sends the reader looking for a problem that is not there.
    bridge.host({ phase: 'reaped' });
    bridge.wire('lost');
    await painted();
    w.app.unmount();
    expect(w.runs()).toEqual(['connecting', 'ready', 'ended']);
  });

  it('a live session whose socket drops is a transport loss, not an ending', async () => {
    const bridge = servedBridge();
    const w = watch(bridge);
    bridge.wire('connected');
    bridge.host({ phase: 'live' });
    await painted();
    bridge.wire('lost');
    await painted();
    w.app.unmount();
    expect(w.runs().at(-1)).toBe('lost');
  });

  it('a bridge with no session plane is ready — one implicit session, however the transport is doing', async () => {
    // Nothing queues it and nothing reports phases, so "waiting" and "ended" are not states it can
    // be in; it must not read as forever-connecting either.
    const w = watch(inProcessBridge());
    await painted();
    w.app.unmount();
    expect([...new Set(w.seen)]).toEqual(['ready']);
  });
});

describe('useRecover', () => {
  it('hands back what the placement provides, and nothing when it provides none', async () => {
    const asked: string[] = [];
    const provided = { ...inProcessBridge(), recover: () => asked.push('engine') };
    let seen: unknown[] = [];
    function View() {
      seen.push(useRecover());
      return createElement(Text, null, 'x');
    }
    const mount = (bridge: Bridge<Ev, never, S>) => render(
      createElement(HarnessProvider<Ev, never, S>, { bridge, initialState: { sum: 0 }, reduce, children: createElement(View) }),
      { stdout: sink(), patchConsole: false, exitOnCtrlC: false, interactive: false },
    );
    const a = mount(provided);
    await painted();
    a.unmount();
    expect(typeof seen[0]).toBe('function');
    (seen[0] as () => void)();
    expect(asked).toEqual(['engine']);

    seen = [];
    const b = mount(inProcessBridge());
    await painted();
    b.unmount();
    // Nothing to offer: the view must be able to leave the button out rather than render a dead one.
    expect(seen[0]).toBeNull();
  });
});
