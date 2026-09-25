/**
 * The served host's per-connection seam: a connection is a Session with its
 * own channels, claimed once by the host's materialise; a harness that throws
 * dies alone and the host's log says why; a disconnect releases the session.
 */
import { describe, it, expect } from 'vitest';
import { run, sleep, suspend } from 'effection';
import type { Operation } from 'effection';
import { createServedHostDriver } from '../src/served-host';
import type { SessionContext } from '@lloyal-labs/sdk';

/** A `ws` socket the test drives: it records frames and can be closed from the client side. */
function fakeSocket() {
  const sent: unknown[] = [];
  const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  const state = { closeCalls: 0 };
  return {
    sent,
    /** How many times anyone called `close()` — the test, or the driver that owns the connection. */
    get closeCalls() { return state.closeCalls; },
    send(data: string) { sent.push(JSON.parse(data)); },
    on(event: string, listener: (...a: unknown[]) => void) { (handlers[event] ??= []).push(listener); },
    close() { state.closeCalls += 1; for (const h of handlers['close'] ?? []) h(); },
    message(frame: unknown) { for (const h of handlers['message'] ?? []) h(JSON.stringify({ sessionId: 'x', frame })); },
    phases: () => sent.filter((f) => (f as { frame: { t: string } }).frame.t === 'session').map((f) => (f as { frame: { payload: { phase: string } } }).frame.payload.phase),
  };
}

const fakeContext = (): SessionContext => ({ dispose() {} } as unknown as SessionContext);

describe('createServedHostDriver', () => {
  it('a connection becomes a live session running the harness over its own channels; a disconnect reaps it', async () => {
    const log: string[] = [];
    const ran: string[] = [];
    await run(function* () {
      const driver = yield* createServedHostDriver<{ type: string }, { type: string }>({
        maxNativeSessions: 2,
        buildContext: async () => fakeContext(),
        *run(m, sessionId): Operation<void> {
          ran.push(sessionId);
          m.uiChannel.send({ type: 'hello' });
          yield* suspend();
        },
        log: (l) => log.push(l),
      });
      const socket = fakeSocket();
      driver.serveConnection(socket as never);
      yield* sleep(20);
      expect(driver.occupancy).toBe(1);
      expect(socket.phases()).toEqual(['queued', 'warming', 'live']);
      expect(socket.sent.some((f) => (f as { frame: { t: string; payload?: { type: string } } }).frame.payload?.type === 'hello')).toBe(true);
      socket.close();
      yield* sleep(20);
      expect(driver.occupancy).toBe(0);
      // The session plane ends with the socket: a client that closed hears nothing further, not even its reap.
      expect(socket.phases().at(-1)).toBe('live');
      expect(log).toEqual([]);
    });
    expect(ran).toHaveLength(1);
  });

  it('a harness that ends closes the connection it owned, after saying why', async () => {
    // The connection's owner closes it. `relay` has always done this on its child's exit; the served
    // driver announces the terminal phase and leaves the socket open, so a browser goes on reporting a
    // harness that is gone and writes every later command into a socket nobody reads.
    //
    // Order is half the law: `wss()` stops routing once the socket closes, so a `reaped` frame that
    // ARRIVES proves it was sent before the close. Announce, then close — the client learns why.
    await run(function* () {
      const driver = yield* createServedHostDriver<{ type: string }, { type: string }>({
        maxNativeSessions: 2,
        buildContext: async () => fakeContext(),
        *run(): Operation<void> { /* the harness returns at once: reload_runtime's exit, a poisoned owner, quit */ },
        log: () => {},
      });
      const socket = fakeSocket();
      driver.serveConnection(socket as never);
      yield* sleep(30);
      expect(socket.phases().at(-1), 'the client was never told its session ended').toBe('reaped');
      expect(socket.closeCalls, 'the harness is gone and the driver left the socket open').toBeGreaterThan(0);
    });
  });

  it('one session failing to bind is its own death: the other stays live and the host keeps serving', async () => {
    const log: string[] = [];
    let admitted = 0;
    await run(function* () {
      const driver = yield* createServedHostDriver<{ type: string }, { type: string }>({
        maxNativeSessions: 2,
        buildContext: async () => fakeContext(),
        *run(): Operation<void> {
          // The first session's service refuses to bind; the second's binds and runs on.
          if (admitted++ === 0) throw new Error('reranker: the model file is not a GGUF');
          yield* suspend();
        },
        log: (l) => log.push(l),
      });
      const a = fakeSocket();
      driver.serveConnection(a as never);
      yield* sleep(30);
      const b = fakeSocket();
      driver.serveConnection(b as never);
      yield* sleep(30);
      expect(a.phases().at(-1)).toBe('died');
      expect(b.phases().at(-1)).toBe('live');
      expect(driver.occupancy).toBe(1);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatch(/died: Error: reranker/);
    });
  });

  it('a harness that throws dies alone, and the host\'s log says why', async () => {
    const log: string[] = [];
    await run(function* () {
      const driver = yield* createServedHostDriver<{ type: string }, { type: string }>({
        maxNativeSessions: 2,
        buildContext: async () => fakeContext(),
        *run(): Operation<void> {
          throw new Error('two native addon images in one process');
        },
        log: (l) => log.push(l),
      });
      const a = fakeSocket();
      const b = fakeSocket();
      driver.serveConnection(a as never);
      driver.serveConnection(b as never);
      yield* sleep(30);
      expect(a.phases().at(-1)).toBe('died');
      expect(b.phases().at(-1)).toBe('died');
      expect(log).toHaveLength(2);
      expect(log[0]).toMatch(/died: Error: two native addon images/);
      expect(driver.occupancy).toBe(0);
      // `died` is terminal too: neither connection has a harness behind it any more.
      expect(a.closeCalls, 'a died session left its socket open').toBeGreaterThan(0);
      expect(b.closeCalls, 'a died session left its socket open').toBeGreaterThan(0);
    });
  });
});
