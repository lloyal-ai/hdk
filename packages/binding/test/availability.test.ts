/**
 * Can this harness take work, and if not, why — the one question a view asks.
 *
 * Two facts answer it and neither answers it alone. The host reports the SESSION
 * (queued behind other users, warming, live, gone); the transport reports the
 * CONNECTION (connecting, connected, dropped). A queued session has a perfectly
 * healthy socket and cannot take work. A session that ended is followed by a
 * close that, read alone, is indistinguishable from a network failure — and the
 * two need different words and a different remedy.
 *
 * So the view derives, it does not store: one function over the two facts, and
 * no third vocabulary kept in step with `SessionState` by hand.
 */
import { describe, it, expect } from 'vitest';
import { availabilityOf } from '../src/projection';

describe('availabilityOf', () => {
  it('before the host has said anything, the transport speaks alone', () => {
    expect(availabilityOf(null, 'connecting')).toBe('connecting');
    expect(availabilityOf(null, 'connected')).toBe('connecting'); // bound, but no session yet
    expect(availabilityOf(null, 'lost')).toBe('lost');
  });

  it('a waiting session has a healthy socket and cannot take work', () => {
    // `wss()` routes `ready` at bind time, BEFORE the host admits, so the transport reaches
    // 'connected' while the session is still queued. No amount of socket handling says "waiting".
    expect(availabilityOf({ phase: 'queued', position: 2 }, 'connected')).toBe('queued');
    expect(availabilityOf({ phase: 'warming' }, 'connected')).toBe('warming');
  });

  it('live over a healthy socket is the only state that takes work', () => {
    expect(availabilityOf({ phase: 'live' }, 'connected')).toBe('ready');
  });

  it('a session that ended reads as ended, and the close that follows does not overwrite it', () => {
    // The producer announces the terminal phase and then closes. If the close won, "your session
    // ended" would degrade into "something went wrong with the network" every single time.
    expect(availabilityOf({ phase: 'reaped' }, 'connected')).toBe('ended');
    expect(availabilityOf({ phase: 'reaped' }, 'lost')).toBe('ended');
    expect(availabilityOf({ phase: 'died', code: 1 }, 'lost')).toBe('ended');
    expect(availabilityOf({ phase: 'draining' }, 'connected')).toBe('ended'); // going away; no work
  });

  it('a live session whose socket drops is a transport loss, not an ending', () => {
    expect(availabilityOf({ phase: 'live' }, 'lost')).toBe('lost');
    expect(availabilityOf({ phase: 'queued' }, 'lost')).toBe('lost');
  });

  it('parked is the placement with no session plane at all', () => {
    // An in-process bridge (the desktop preload) has no host to report phases; it is ready when its
    // transport is. `parked` is the host's word for a session that exists and is not yet queued.
    expect(availabilityOf({ phase: 'parked' }, 'connected')).toBe('connecting');
  });
});
