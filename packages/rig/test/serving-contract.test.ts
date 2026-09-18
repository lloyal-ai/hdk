/**
 * What every serving adapter owes a connection, whichever way it hosts a harness.
 *
 * Two of them exist. `@lloyal-labs/relay` forks a child process per connection —
 * one model residency each, the self-host shape. rig's served-host driver
 * multiplexes N sessions over one resident model in one process. They are
 * different execution models and they have earned different adapters; what they
 * share is a wire — binding's session plane and run plane — and a reader at the
 * other end of it who cannot tell which one is serving them.
 *
 * Nothing was checking that they still agreed, and they drifted. Relay has always
 * closed the socket when its child died; the driver, written later, announced the
 * terminal phase and left the socket open, which left a browser reporting a
 * harness that was gone and writing every later command into a socket nobody read.
 * One suite over both is what would have caught it, and it is cheaper than merging
 * them would have been.
 *
 * So: the contract, stated once, run against each. Nothing here knows how either
 * one hosts anything.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { run as effection, sleep, until } from 'effection';
import type { Operation } from 'effection';
import type { SessionContext } from '@lloyal-labs/sdk';
import { createServedHostDriver } from '../src/served-host';

// Relay forks for real; the fake child lets its lifecycle be driven without a bin.
// Hoisted because the factory runs before module imports. The driver forks nothing,
// so this is inert for its half of the suite.
const forked = vi.hoisted(() => {
  const makeChild = () => {
    const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
    const child = {
      killed: false,
      connected: true,
      send: vi.fn(),
      kill: vi.fn(() => { child.killed = true; }),
      on(ev: string, cb: (...a: unknown[]) => void) { (listeners[ev] ??= []).push(cb); },
      emit(ev: string, ...args: unknown[]) { (listeners[ev] ?? []).forEach((cb) => cb(...args)); },
    };
    return child;
  };
  const state: { child?: ReturnType<typeof makeChild> } = {};
  const fork = vi.fn(() => { state.child = makeChild(); return state.child; });
  return { state, fork };
});
vi.mock('node:child_process', () => ({ fork: forked.fork }));

import { bridgeConnection } from '../../relay/src/index';
import type { RelaySocket } from '../../relay/src/index';

/** The socket both adapters are handed: what the client sees, and what the adapter may do to it. */
class FakeSocket {
  sent: unknown[] = [];
  closeCalls = 0;
  failSends = false;
  private handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  send(data: string): void {
    if (this.failSends) throw new Error('socket died without a clean close');
    this.sent.push(JSON.parse(data));
  }
  on(event: string, listener: (...a: unknown[]) => void): void { (this.handlers[event] ??= []).push(listener); }
  close(): void { this.closeCalls += 1; this.fire('close'); }
  fire(event: string, ...args: unknown[]): void { for (const h of this.handlers[event] ?? []) h(...args); }
  /** The session phases the client has been told, in order. */
  phases(): string[] {
    return this.sent
      .filter((f) => (f as { frame?: { t?: string } }).frame?.t === 'session')
      .map((f) => (f as { frame: { payload: { phase: string } } }).frame.payload.phase);
  }
}

interface Connection {
  socket: FakeSocket;
  /** Make the thing behind this connection end the way it ordinarily would. */
  endHarness(): Promise<void>;
}

interface Adapter {
  name: string;
  /** Serve one connection, run `body` against it, then tear down. */
  serve(body: (c: Connection) => Promise<void>): Promise<void>;
}

const TERMINAL = ['died', 'reaped'];
const fakeContext = (): SessionContext => ({ dispose() {} } as unknown as SessionContext);
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

const relay: Adapter = {
  name: 'relay — a child process per connection',
  async serve(body) {
    const socket = new FakeSocket();
    const dispose = bridgeConnection(socket as unknown as RelaySocket, { harness: { bin: 'the-harness-bin' } });
    const child = forked.state.child!;
    child.emit('message', { t: 'ready' });   // the child's own ready: relay reads it as `live`
    try {
      await body({ socket, endHarness: async () => { child.emit('exit', 0, null); await tick(); } });
    } finally {
      dispose();
    }
  },
};

const servedHost: Adapter = {
  name: 'served host — N sessions over one resident model',
  async serve(body) {
    let end!: () => void;
    const ended = new Promise<void>((resolve) => { end = resolve; });
    await effection(function* () {
      const driver = yield* createServedHostDriver<{ type: string }, { type: string }>({
        maxNativeSessions: 1,
        buildContext: async () => fakeContext(),
        *run(): Operation<void> { yield* until(ended); },
        log: () => {},
      });
      const socket = new FakeSocket();
      driver.serveConnection(socket as never);
      yield* sleep(20);   // admitted, materialised, live
      yield* until(body({ socket, endHarness: async () => { end(); await tick(); } }));
    });
  },
};

beforeEach(() => forked.fork.mockClear());

describe.each([relay, servedHost])('a serving adapter: $name', (adapter) => {
  it('tells the client about the session, not only about the work', async () => {
    await adapter.serve(async ({ socket }) => {
      // The run plane carries what the harness says; the session plane carries what became of the
      // session itself. A client with only the first cannot tell waiting from working from gone.
      expect(socket.phases().length).toBeGreaterThan(0);
    });
  });

  it('announces the end of the session, and THEN closes the connection it was for', async () => {
    // This is the one that drifted. Both halves matter and the order is half the law: an adapter
    // that closes first leaves "the network dropped", which is a different thing with a different
    // remedy; one that never closes leaves a page that believes it can still take work.
    await adapter.serve(async ({ socket, endHarness }) => {
      await endHarness();
      expect(socket.phases().at(-1), 'the client was never told the session ended').toBeOneOf(TERMINAL);
      expect(socket.closeCalls, 'the harness is gone and the connection was left open').toBeGreaterThan(0);
    });
  });

  it('a client that hangs up is the end of it: nothing is routed afterwards', async () => {
    await adapter.serve(async ({ socket, endHarness }) => {
      socket.close();
      const after = socket.sent.length;
      await endHarness();
      expect(socket.sent.length, 'frames were routed to a socket the client had already closed').toBe(after);
    });
  });

  it('a socket that dies mid-send does not take the adapter with it', async () => {
    // A socket can die without a clean `close` event, so the failing send IS the notification.
    // Throwing from there would reach the host's connection handler, or the pump.
    await adapter.serve(async ({ socket, endHarness }) => {
      socket.failSends = true;
      await expect(endHarness()).resolves.toBeUndefined();
    });
  });
});
