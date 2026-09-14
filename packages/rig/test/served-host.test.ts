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
  return {
    sent,
    send(data: string) { sent.push(JSON.parse(data)); },
    on(event: string, listener: (...a: unknown[]) => void) { (handlers[event] ??= []).push(listener); },
    close() { for (const h of handlers['close'] ?? []) h(); },
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
    });
  });
});
