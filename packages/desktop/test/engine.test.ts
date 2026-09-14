/**
 * The shell's engine: frames numbered within one epoch and forwarded; the
 * shell's own fold answering the snapshot; uploads relayed to the engine and
 * settled by its answer, its cancel, or its death.
 */
import { describe, it, expect } from 'vitest';
import { createEngine } from '../src/engine';
import type { EngineProcess } from '../src/engine';
import type { Frame } from '@lloyal-labs/binding';

type Ev = { type: 'n'; n: number };
type S = { sum: number };

/** A utility process the test drives: it records posts and lets the test speak as the engine. */
function fakeProcess() {
  const listeners: Record<string, ((m: unknown) => void)[]> = {};
  const posted: unknown[] = [];
  let alive = true;
  const proc: EngineProcess & { say(m: unknown): void; exit(code: number): void; posted: unknown[] } = {
    posted,
    postMessage(m: unknown) { if (!alive) throw new Error('dead'); posted.push(m); },
    on(event: string, listener: (m: never) => void) { (listeners[event] ??= []).push(listener as (m: unknown) => void); return proc; },
    kill() { alive = false; return true; },
    say(m: unknown) { for (const l of listeners['message'] ?? []) l(m); },
    exit(code: number) { alive = false; for (const l of listeners['exit'] ?? []) l(code); },
  } as never;
  return proc;
}

describe('createEngine', () => {
  it('numbers and forwards every event within one epoch, and answers the snapshot from its own fold', () => {
    const proc = fakeProcess();
    const forwarded: Frame<Ev>[] = [];
    const engine = createEngine<Ev, { type: 'x' }, S>({ fork: () => proc, initialState: { sum: 0 }, reduce: (s, ev) => ({ sum: s.sum + ev.n }), forward: (f) => forwarded.push(f) });
    proc.say({ t: 'event', payload: { type: 'n', n: 2 } });
    proc.say({ t: 'event', payload: { type: 'n', n: 3 } });
    proc.say({ t: 'ready' });
    expect(forwarded.map((f) => [f.seq, f.ev.n])).toEqual([[1, 2], [2, 3]]);
    expect(new Set(forwarded.map((f) => f.epoch)).size).toBe(1);
    expect(engine.snapshot()).toEqual({ state: { sum: 5 }, epoch: forwarded[0].epoch, seq: 2 });
    expect(engine.send({ type: 'x' })).toBe(true);
    expect(proc.posted.at(-1)).toEqual({ t: 'command', payload: { type: 'x' } });
  });

  it('relays an upload and settles it by the engine\'s answer, by a cancel, or by the engine\'s death', async () => {
    const proc = fakeProcess();
    const engine = createEngine<Ev, never, S>({ fork: () => proc, initialState: { sum: 0 }, reduce: (s) => s, forward: () => {} });
    const root = { mediaType: 'm', digest: 'sha256:' + '0'.repeat(64), size: 1 };
    const ok = engine.ingest(new Uint8Array([1]), new AbortController().signal);
    const sent = proc.posted.at(-1) as { t: string; id: number };
    expect(sent.t).toBe('ingest');
    proc.say({ t: 'ingested', id: sent.id, root });
    await expect(ok).resolves.toEqual(root);

    const ctrl = new AbortController();
    const cancelled = engine.ingest(new Uint8Array([2]), ctrl.signal);
    ctrl.abort();
    await expect(cancelled).rejects.toThrow(/cancelled/);
    expect(proc.posted.at(-1)).toMatchObject({ t: 'ingestCancel' });

    const aborted = new AbortController();
    aborted.abort();
    await expect(engine.ingest(new Uint8Array([3]), aborted.signal)).rejects.toThrow(/cancelled/);

    const orphan = engine.ingest(new Uint8Array([4]), new AbortController().signal);
    proc.exit(1);
    await expect(orphan).rejects.toThrow(/engine stopped/);
    expect(engine.running).toBe(false);
    expect(engine.send({} as never)).toBe(false);
    await expect(engine.ingest(new Uint8Array([5]), new AbortController().signal)).rejects.toThrow(/not running/);
  });
});
