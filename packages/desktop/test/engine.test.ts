/**
 * The shell's engine: frames numbered within one epoch and forwarded; the
 * shell's own fold answering the snapshot; uploads relayed to the engine and
 * settled by its answer, its cancel, or its death.
 */
import { describe, it, expect } from 'vitest';
import { createEngine } from '../src/engine';
import type { EngineProcess } from '../src/engine';
import type { Frame, SessionState } from '@lloyal-labs/binding';

type Ev = { type: 'n'; n: number };
type S = { sum: number };

/** A utility process the test drives: it records posts and lets the test speak as the engine. */
function fakeProcess() {
  const listeners: Record<string, ((m: unknown) => void)[]> = {};
  const posted: unknown[] = [];
  let alive = true;
  const proc: EngineProcess & { say(m: unknown): void; exit(code: number): void; posted: unknown[]; killed: boolean } = {
    posted,
    killed: false,
    postMessage(m: unknown) { if (!alive) throw new Error('dead'); posted.push(m); },
    on(event: string, listener: (m: never) => void) { (listeners[event] ??= []).push(listener as (m: unknown) => void); return proc; },
    kill() { alive = false; proc.killed = true; return true; },
    say(m: unknown) { for (const l of listeners['message'] ?? []) l(m); },
    exit(code: number) { alive = false; for (const l of listeners['exit'] ?? []) l(code); },
  } as never;
  return proc;
}

describe('createEngine', () => {
  it('numbers and forwards every event within one epoch, and answers the snapshot from its own fold', () => {
    const proc = fakeProcess();
    const forwarded: Frame<Ev>[] = [];
    const engine = createEngine<Ev, { type: 'x' }, S>({ bin: 'engine-not-forked-in-this-test', fork: () => proc, initialState: { sum: 0 }, reduce: (s, ev) => ({ sum: s.sum + ev.n }), forward: (f) => forwarded.push(f) });
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
    const engine = createEngine<Ev, never, S>({ bin: 'engine-not-forked-in-this-test', fork: () => proc, initialState: { sum: 0 }, reduce: (s) => s, forward: () => {} });
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

describe('the engine publishes its session', () => {
  /** Fresh processes, in the order the engine asked for them. */
  function forker() {
    const made: ReturnType<typeof fakeProcess>[] = [];
    return { made, fork: () => { const p = fakeProcess(); made.push(p); return p; } };
  }
  const phases = (seen: SessionState[]): string[] => seen.map((s) => s.phase);
  function start(f: { fork: () => EngineProcess }, bin = 'engine') {
    const seen: SessionState[] = [];
    const forwarded: Frame<Ev>[] = [];
    const engine = createEngine<Ev, { type: 'x' }, S>({
      bin, fork: f.fork, initialState: { sum: 0 }, reduce: (s, ev) => ({ sum: s.sum + ev.n }), forward: (fr) => forwarded.push(fr),
    });
    engine.onSession((s) => seen.push(s));
    return { engine, seen, forwarded };
  }

  it('warming at the fork, live only when the child says it is ready', () => {
    // A child exists while it is still loading a model. Its `ready` frame is the boundary that
    // means something — the command channel is attached — so "running" is far too early to
    // tell a reader their harness can take work.
    const f = forker();
    const { engine, seen } = start(f);
    expect(engine.session().phase).toBe('warming');
    f.made[0].say({ t: 'event', payload: { type: 'n', n: 1 } });   // events can precede ready
    expect(engine.session().phase).toBe('warming');
    f.made[0].say({ t: 'ready' });
    expect(phases(seen)).toEqual(['warming', 'live']);
    // A view that mounts now — a renderer reload over a healthy engine — is told where things stand.
    const late: SessionState[] = [];
    engine.onSession((s) => late.push(s));
    expect(phases(late)).toEqual(['live']);
  });

  it('a stop we asked for drains and reaps; an exit nobody asked for died', () => {
    const a = forker();
    const one = start(a);
    a.made[0].say({ t: 'ready' });
    one.engine.kill();
    expect(one.engine.session().phase).toBe('draining');   // asked to go, still there
    a.made[0].exit(0);
    expect(phases(one.seen)).toEqual(['warming', 'live', 'draining', 'reaped']);

    const b = forker();
    const two = start(b);
    b.made[0].say({ t: 'ready' });
    b.made[0].exit(1);   // nobody asked: the engine went on its own
    expect(phases(two.seen)).toEqual(['warming', 'live', 'died']);
    expect((two.seen.at(-1) as { phase: 'died'; code?: number }).code).toBe(1);
  });

  it('a fork that fails is a died session, not a crash in the shell', () => {
    const seen: SessionState[] = [];
    const engine = createEngine<Ev, never, S>({
      bin: 'missing', fork: () => { throw new Error('engine not built'); },
      initialState: { sum: 0 }, reduce: (s) => s, forward: () => {},
    });
    engine.onSession((s) => seen.push(s));
    expect(phases(seen)).toEqual(['died']);
    expect(engine.running).toBe(false);
  });

  it('restart waits for the process to actually go before forking its replacement, and is idempotent', async () => {
    // `draining` means "cannot take work", NOT "the resources are gone": the model is still
    // resident until the process exits. Forking on the announcement would put two engines on one
    // machine's memory at once.
    const f = forker();
    const { engine, seen } = start(f);
    f.made[0].say({ t: 'ready' });
    const first = engine.restart();
    const second = engine.restart();          // the reader pressed it twice
    expect(f.made).toHaveLength(1);           // nothing forked while the old one is still alive
    expect(engine.session().phase).toBe('draining');
    f.made[0].exit(0);
    await turn();
    expect(f.made, 'two presses forked two engines').toHaveLength(2);
    // The promise settles when the replacement is USABLE, not when it was forked: what the reader
    // asked for is a working harness, and between the fork and `ready` there is not one yet.
    f.made[1].say({ t: 'ready' });
    await Promise.all([first, second]);
    expect(phases(seen)).toEqual(['warming', 'live', 'draining', 'warming', 'live']);
  });

  const turn = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('a second recovery while the replacement is starting reuses it, rather than killing it', async () => {
    // The reader presses it again a moment later — a different IPC turn, not the same tick. The
    // replacement is forked by then but still loading a model, so restarting it achieves nothing
    // except throwing away the loading it has done and starting the wait over.
    const f = forker();
    const { engine, seen } = start(f);
    f.made[0].say({ t: 'ready' });
    const first = engine.restart();
    f.made[0].exit(0);
    await turn();
    expect(f.made, 'the replacement should be forked by now').toHaveLength(2);
    expect(engine.session().phase).toBe('warming');

    const second = engine.restart();
    await turn();
    expect(f.made, 'a third engine was forked while the second was still starting').toHaveLength(2);
    expect(f.made[1].killed, 'the replacement was killed while it was still coming up').toBe(false);

    f.made[1].say({ t: 'ready' });
    await Promise.all([first, second]);
    expect(phases(seen)).toEqual(['warming', 'live', 'draining', 'warming', 'live']);
  });

  it('a replacement that fails to start leaves recovery available again', async () => {
    // Coalescing must not become a latch: if the startup died, the next press is the reader's only
    // way out and has to actually do something.
    let forks = 0;
    const made: ReturnType<typeof fakeProcess>[] = [];
    const seen: SessionState[] = [];
    const engine = createEngine<Ev, never, S>({
      bin: 'engine',
      fork: () => {
        forks += 1;
        if (forks === 2) throw new Error('engine not built');
        const p = fakeProcess();
        made.push(p);
        return p;
      },
      initialState: { sum: 0 }, reduce: (s) => s, forward: () => {},
    });
    engine.onSession((s) => seen.push(s));
    made[0].say({ t: 'ready' });
    made[0].exit(0);
    await engine.restart();                       // fork 2 throws: settles at `died`, not never
    expect(engine.session().phase).toBe('died');
    const again = engine.restart();               // fork 3 succeeds
    await turn();
    expect(forks).toBe(3);
    expect(engine.session().phase).toBe('warming');
    made[1].say({ t: 'ready' });
    await again;
    expect(engine.session().phase).toBe('live');
  });

  it('a replacement is a new stream: its own epoch and fold, and the old child is ignored', async () => {
    const f = forker();
    const { engine, forwarded } = start(f);
    f.made[0].say({ t: 'ready' });
    f.made[0].say({ t: 'event', payload: { type: 'n', n: 5 } });
    const before = engine.snapshot();
    expect(before.state).toEqual({ sum: 5 });
    const restarted = engine.restart();
    f.made[0].exit(0);
    await turn();
    f.made[1].say({ t: 'ready' });
    await restarted;
    // The dead child speaking after its replacement exists must reach nothing: its listeners are
    // still attached to a process object the shell no longer owns.
    f.made[0].say({ t: 'event', payload: { type: 'n', n: 99 } });
    const after = engine.snapshot();
    expect(after.state, "the old engine's events were folded into the new one").toEqual({ sum: 0 });
    expect(after.epoch, 'the replacement reused the epoch, so a renderer cannot tell the streams apart').not.toBe(before.epoch);
    expect(after.seq).toBe(0);
    f.made[1].say({ t: 'event', payload: { type: 'n', n: 7 } });
    expect(engine.snapshot()).toEqual({ state: { sum: 7 }, epoch: after.epoch, seq: 1 });
    expect(forwarded.filter((fr) => fr.epoch === after.epoch).map((fr) => fr.ev.n)).toEqual([7]);
  });
});
