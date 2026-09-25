/**
 * The provider connects a bridge once; the hooks read its projection. Rendered
 * on the server, a component sees the projection's snapshot at render time,
 * and a named selector's result keeps one identity per fold.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { Bridge, Frame } from '@lloyal-labs/binding';
import { HarnessProvider, useProjection, useConnection, useContentOrigin } from '../src/provider';

type Ev = { type: 'n'; n: number };
type S = { sum: number };
const reduce = (s: S, ev: Ev): S => ({ sum: s.sum + ev.n });

function bridge(seed: S, origin?: string): Bridge<Ev, never, S> & { emit(n: number): void } {
  const subs = new Set<(f: Frame<Ev>) => void>();
  let seq = 0;
  let state = seed;
  return {
    onEvent(cb) { subs.add(cb); return () => subs.delete(cb); },
    send() {},
    requestSnapshot: () => Promise.resolve({ state, epoch: 1, seq }),
    ...(origin !== undefined ? { contentOrigin: () => origin } : {}),
    emit(n) {
      seq += 1;
      state = reduce(state, { type: 'n', n });
      for (const cb of subs) cb({ epoch: 1, seq, ev: { type: 'n', n } });
    },
  };
}

const selectSum = (s: S): number => s.sum;
const selectBox = (s: S): { sum: number } => ({ sum: s.sum });

describe('HarnessProvider and the hooks', () => {
  it('a component reads the projection; the provider connects the bridge once per bridge', async () => {
    const b = bridge({ sum: 0 }, '');
    let seen: unknown[] = [];
    function View() {
      seen.push([useProjection(selectSum), useConnection(), useContentOrigin()]);
      return createElement('span', null, String(useProjection(selectSum)));
    }
    const tree = createElement(HarnessProvider<Ev, never, S>, { bridge: b, initialState: { sum: 0 }, reduce, children: createElement(View) });
    expect(renderToString(tree)).toContain('<span>0</span>');
    expect(seen[0]).toEqual([0, 'connected', '']);
    seen = [];
    await new Promise((r) => setTimeout(r, 5));   // the projection seeds from the bridge's snapshot on a microtask
    b.emit(5);
    // A second render under the same bridge reattaches to the running projection and sees the fold.
    expect(renderToString(createElement(HarnessProvider<Ev, never, S>, { bridge: b, initialState: { sum: 0 }, reduce, children: createElement(View) }))).toContain('<span>5</span>');
  });

  it('a state mutated in place keeps its identity, so the memo keeps answering with the old fold', () => {
    // The requirement the type system cannot carry. `derived` is keyed by the
    // snapshot, so mutating a state rather than replacing it leaves the cache
    // pointing at the selection it computed for the PREVIOUS fold. Pinned as
    // behaviour because the failure is silent: the view simply stops updating.
    const state: S = { sum: 1 };
    const seen: number[] = [];
    const b = bridge(state);
    function View() {
      seen.push(useProjection(selectSum));
      return null;
    }
    const tree = createElement(HarnessProvider<Ev, never, S>, { bridge: b, initialState: state, reduce, children: createElement(View) });
    renderToString(tree);
    state.sum = 99;                    // in place — the identity does not change
    renderToString(tree);
    expect(seen[1]).toBe(seen[0]);     // and the selection is the one cached for the old fold
    expect(seen[1]).not.toBe(99);
  });

  it('a named selector that builds an object returns one identity per fold', () => {
    const b = bridge({ sum: 1 });
    const boxes: object[] = [];
    function View() {
      boxes.push(useProjection(selectBox), useProjection(selectBox));
      return null;
    }
    renderToString(createElement(HarnessProvider<Ev, never, S>, { bridge: b, initialState: { sum: 0 }, reduce, children: createElement(View) }));
    expect(boxes[0]).toBe(boxes[1]);
    expect(boxes[0]).toEqual({ sum: 0 });   // the server snapshot precedes the bridge's answer: the initial state
  });
});

/**
 * The state contract, checked by the COMPILER — `tsconfig.test.json` covers this
 * file, so these are real assertions and not decoration.
 *
 * `useProjection` memoizes in a `WeakMap` keyed by the snapshot, so a scalar or
 * `null` state is not a legal key. Before `S extends object` the signature
 * accepted them and a double cast hid it, which made the failure a runtime
 * `TypeError: Invalid value used as weak map key` instead of a compile error.
 *
 * Never invoked: a hook called outside a component throws, and there is nothing
 * to run here anyway — the assertion is that this file compiles.
 */
interface Fold {
  sum: number;
}
function stateMustBeObjectShaped(): void {
  useProjection<Fold, number>((state) => state.sum);   // an ordinary interface is accepted

  // @ts-expect-error a number cannot key a WeakMap
  useProjection<number, number>((n) => n);
  // @ts-expect-error nor can a string
  useProjection<string, number>((t) => t.length);
  // @ts-expect-error nor null
  useProjection<null, number>(() => 0);
}

describe('the state must be object-shaped', () => {
  it('is asserted by the compiler, above', () => {
    expect(typeof stateMustBeObjectShaped).toBe('function');
  });
});

describe('the install in front of the view', () => {
  const running = [{ id: 'llm', label: 'Downloading the reasoning model', status: 'running' as const }];
  const failed = [{ id: 'machine', label: 'This machine', status: 'failed' as const, note: '8 GB · 10 GB needed' }];

  const failedLlm = [{ id: 'llm', label: 'Downloading the reasoning model', status: 'failed' as const, note: 'Failed to fetch from any source' }];

  it('installView: the whole matrix — no steps is the app; steps with a live engine are the installer, failed or not; any list after the engine ended is an install that did not finish, handed to recovery — the download the engine died under included — unless the failed row is the machine\'s, which no engine can mend', async () => {
    const { installView } = await import('../src/provider');
    expect(installView([], 'ready')).toBe('app');
    expect(installView([], 'ended')).toBe('app');
    for (const live of ['connecting', 'warming', 'queued', 'ready'] as const) {
      expect(installView(running, live), live).toBe('acquiring');
      expect(installView(failedLlm, live), live).toBe('acquiring');   // retry / a file / stop are on offer
      expect(installView(failed, live), live).toBe('acquiring');
    }
    for (const gone of ['ended', 'lost'] as const) {
      expect(installView(failedLlm, gone), gone).toBe('ended');
      expect(installView(failed, gone), gone).toBe('refused');
      expect(installView(running, gone), gone).toBe('ended');   // the engine died mid-download: not the app
    }
  });

  it('subscribeInstall: a placement that has installNow and fails to answer is a failed step, never a run that acquires nothing', async () => {
    const { subscribeInstall } = await import('../src/provider');
    const b = { onEvent() { return () => {}; }, installNow: () => Promise.reject(new Error("No handler registered for 'harness:install-now'")) };
    const seen: unknown[] = [];
    subscribeInstall(b, (steps) => seen.push(steps));
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([[{ id: 'install', label: 'Asking what this run needs', status: 'failed', note: "No handler registered for 'harness:install-now'" }]]);
  });

  it('subscribeInstall: the push wins — an answer that arrives after a frame never overwrites it; an answer with no frame stands', async () => {
    const { subscribeInstall } = await import('../src/provider');
    let answer!: (v: unknown) => void;
    const subs = new Set<(f: { epoch: number; seq: number; ev: unknown }) => void>();
    const b = {
      onEvent(cb: (f: { epoch: number; seq: number; ev: unknown }) => void) { subs.add(cb); return () => subs.delete(cb); },
      installNow: () => new Promise<unknown>((r) => { answer = r; }),
    };
    const seen: unknown[] = [];
    const off = subscribeInstall(b, (steps) => seen.push(steps));
    for (const cb of subs) cb({ epoch: 1, seq: 1, ev: { type: 'install:step', steps: [] } });   // the final frame: over
    answer({ type: 'install:step', steps: running });                                            // an older answer, late
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([[]]);
    off();

    const late: unknown[] = [];
    const b2 = { onEvent() { return () => {}; }, installNow: () => Promise.resolve({ type: 'install:step', steps: running }) };
    subscribeInstall(b2, (steps) => late.push(steps));
    await new Promise((r) => setTimeout(r, 0));
    expect(late).toEqual([running]);
  });

  it('subscribeInstall: the steps follow the engine — a failed boot, recovery, then a fully cached boot that publishes nothing clears the installer at `warming`, with the subscription mounted throughout', async () => {
    const { subscribeInstall } = await import('../src/provider');
    // A desktop bridge as the renderer sees it: frames, the session channel announcing where things stand
    // and every change, and `installNow` answering what the CURRENT engine retains (null after a replacement).
    type Session = { phase: 'warming' | 'live' | 'draining' | 'died' };
    const subs = new Set<(f: { epoch: number; seq: number; ev: unknown }) => void>();
    const sessions = new Set<(s: Session) => void>();
    let session: Session = { phase: 'died' };
    let retained: unknown = { type: 'install:step', steps: failed };
    const asked: unknown[] = [];
    const announce = (s: Session): void => { session = s; for (const cb of sessions) cb(s); };
    const b = {
      onEvent(cb: (f: { epoch: number; seq: number; ev: unknown }) => void) { subs.add(cb); return () => subs.delete(cb); },
      onSession(cb: (s: Session) => void) { sessions.add(cb); cb(session); return () => sessions.delete(cb); },
      installNow: () => { asked.push(retained); return Promise.resolve(retained); },
    };
    const seen: unknown[] = [];
    const off = subscribeInstall(b as never, (steps) => seen.push(steps));
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([failed]);                  // the renderer loaded after the machine refusal ended the engine
    // The reader presses "Start a new engine": the shell drains the old one, drops its retained install,
    // forks the replacement — which finds every slot full and publishes nothing — and it goes live.
    announce({ phase: 'draining' });
    retained = null;
    announce({ phase: 'warming' });
    announce({ phase: 'live' });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([failed, []]);
    expect(asked).toEqual([{ type: 'install:step', steps: failed }, null]);
    // A replacement that fails again pushes its own rows, and they show.
    announce({ phase: 'draining' });
    announce({ phase: 'warming' });
    for (const cb of subs) cb({ epoch: 2, seq: 1, ev: { type: 'install:step', steps: running } });
    expect(seen).toEqual([failed, [], [], running]);
    off();
  });

  it('subscribeInstall: an answer from the engine before the replacement is never applied to the replacement', async () => {
    const { subscribeInstall } = await import('../src/provider');
    type Session = { phase: 'warming' | 'live' };
    const sessions = new Set<(s: Session) => void>();
    const answers: Array<(v: unknown) => void> = [];
    const b = {
      onEvent() { return () => {}; },
      onSession(cb: (s: Session) => void) { sessions.add(cb); cb({ phase: 'live' }); return () => sessions.delete(cb); },
      installNow: () => new Promise<unknown>((r) => { answers.push(r); }),
    };
    const seen: unknown[] = [];
    subscribeInstall(b as never, (steps) => seen.push(steps));
    expect(answers).toHaveLength(1);                 // mounted at `live`: asked once, nothing cleared
    for (const cb of sessions) cb({ phase: 'warming' });
    expect(answers).toHaveLength(2);
    answers[0]({ type: 'install:step', steps: failed });   // the old engine's answer, late
    answers[1](null);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([[]]);
  });

  it('subscribeInstall: after unsubscribing, neither source is heard', async () => {
    const { subscribeInstall } = await import('../src/provider');
    let answer!: (v: unknown) => void;
    const b = { onEvent() { return () => {}; }, installNow: () => new Promise<unknown>((r) => { answer = r; }) };
    const seen: unknown[] = [];
    const off = subscribeInstall(b, (steps) => seen.push(steps));
    off();
    answer({ type: 'install:step', steps: running });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([]);
  });
});
