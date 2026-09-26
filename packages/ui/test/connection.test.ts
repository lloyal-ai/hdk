/**
 * The wire's status, read on a CLIENT render. `useConnection` must report every
 * status the bridge reports, and hold the one it has across a re-render it did
 * not cause — laws a server render cannot pin, because `renderToString` reads
 * `getServerSnapshot` and never subscribes.
 *
 * The client render is driven by Ink, the workspace's React renderer for a
 * terminal: `useSyncExternalStore` lives in the reconciler, not in a host, so
 * the hook runs here exactly as it does in a browser. The stream is a sink and
 * the output is never read — only what the component saw, render by render.
 */
import { describe, it, expect } from 'vitest';
import { createElement, useState } from 'react';
import { Writable } from 'node:stream';
import { render, Text } from 'ink';
import type { Bridge, WireStatus } from '@lloyal-labs/binding';
import { HarnessProvider, useConnection } from '../src/provider';

type Ev = { type: 'n'; n: number };
type S = { sum: number };
const reduce = (s: S, ev: Ev): S => ({ sum: s.sum + ev.n });

/** A bridge with a droppable link: `onStatus` reports the status at once, then
 *  on every change — the contract `createBridge` keeps over a socket. */
function wiredBridge(): Bridge<Ev, never, S> & { report(status: WireStatus): void; readonly subscribes: number } {
  let status: WireStatus = 'connecting';
  let subscribes = 0;
  const listeners = new Set<(status: WireStatus) => void>();
  return {
    onEvent: () => () => {},
    send: () => {},
    requestSnapshot: () => Promise.resolve({ state: { sum: 0 }, epoch: 1, seq: 0 }),
    onStatus(cb) {
      subscribes += 1;
      listeners.add(cb);
      cb(status);
      return () => { listeners.delete(cb); };
    },
    report(next) {
      status = next;
      for (const cb of listeners) cb(next);
    },
    get subscribes() { return subscribes; },
  };
}

/** Ink writes frames to the terminal; a test wants none of them. */
function sink(): NodeJS.WriteStream {
  const stream = new Writable({ write(_chunk, _encoding, done) { done(); } });
  return Object.assign(stream, { columns: 80, rows: 24 }) as unknown as NodeJS.WriteStream;
}

function mount(node: ReturnType<typeof createElement>) {
  return render(node, { stdout: sink(), patchConsole: false, exitOnCtrlC: false, interactive: false });
}

/** Long enough for Ink to commit whatever React has scheduled. */
const painted = (): Promise<void> => new Promise((r) => setTimeout(r, 80));

/** The statuses in the order they appeared, with a repeat of the one before folded away. */
const runs = (seen: WireStatus[]): WireStatus[] => seen.filter((s, i) => s !== seen[i - 1]);

describe('useConnection on a client render', () => {
  it('reports every status the bridge reports, and subscribes to the wire once', async () => {
    const bridge = wiredBridge();
    const seen: WireStatus[] = [];
    function View() {
      const status = useConnection();
      seen.push(status);
      return createElement(Text, null, status);
    }
    const app = mount(createElement(HarnessProvider<Ev, never, S>, {
      bridge, initialState: { sum: 0 }, reduce, children: createElement(View),
    }));
    await painted();
    bridge.report('connected');
    await painted();
    bridge.report('lost');
    await painted();
    app.unmount();

    expect(seen[0]).toBe('connecting');                          // the status at first paint, not a default
    expect(runs(seen)).toEqual(['connecting', 'connected', 'lost']);
    expect(bridge.subscribes).toBe(1);                           // one subscription, not one per render
  });

  it('holds the status across a re-render it did not cause', async () => {
    const bridge = wiredBridge();
    const seen: WireStatus[] = [];
    let bump: (n: number) => void = () => {};
    function View() {
      const [n, setN] = useState(0);
      bump = setN;
      seen.push(useConnection());
      return createElement(Text, null, String(n));
    }
    const app = mount(createElement(HarnessProvider<Ev, never, S>, {
      bridge, initialState: { sum: 0 }, reduce, children: createElement(View),
    }));
    await painted();
    bridge.report('lost');
    await painted();

    seen.length = 0;
    bump(1);                                                     // a render the wire had no part in
    await painted();
    app.unmount();

    expect(seen).not.toEqual([]);                                // the re-render did happen
    expect([...new Set(seen)]).toEqual(['lost']);                // and it did not reset the status
  });
});
