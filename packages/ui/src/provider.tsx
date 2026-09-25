/**
 * The projection, in React: a provider that connects a bridge once, and hooks
 * that read the fold, the wire's status, the command sink and the content
 * plane's origin. One projection per provider; a remount under the same bridge
 * reattaches to the running fold, it never re-subscribes or resets.
 *
 * `useProjection(select)` memoizes per fold: the state is immutable between
 * events, so a named selector returns the SAME reference until the next fold —
 * what `useSyncExternalStore` needs. The contract: a selector with a stable
 * identity may build objects; an inline selector must return a primitive.
 *
 * The folded state must be an OBJECT, and a new one on every event. Both halves
 * are load-bearing and neither is a style preference: the memo is a `WeakMap`
 * keyed by the snapshot, so a scalar or `null` state is not a legal key at all,
 * and a state mutated in place keeps its identity and so keeps returning the
 * selection cached against the previous fold. `S extends object` states the
 * first half to the compiler. The second is a discipline the type system cannot
 * carry, which is why it is written here.
 *
 * @category UI
 */
import { createContext, createElement, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Fragment } from 'react';
import { connectProjection, availabilityOf } from '@lloyal-labs/binding';
import type { Availability, Bridge, Projection, SessionState, WireStatus } from '@lloyal-labs/binding';
import { Installer } from './installer.js';
import type { InstallerStep } from './installer.js';

export interface Harness<E, C, S extends object> {
  bridge: Bridge<E, C, S>;
  projection: Projection<S>;
}

// `object`, not `unknown`, is what the erased context can say now that `S` is
// constrained — the hooks below cast back out of it exactly as before.
const HarnessContext = createContext<Harness<unknown, unknown, object> | null>(null);

/** One projection per bridge, for the life of the page: a React remount under the same bridge reattaches. */
const projections = new WeakMap<object, Projection<unknown>>();

/** The one projection over a bridge — the provider's, shared with a consumer outside React (a history adapter). */
export function projectionFor<E, C, S extends object>(bridge: Bridge<E, C, S>, initialState: S, reduce: (state: S, ev: E) => S): Projection<S> {
  let projection = projections.get(bridge) as Projection<S> | undefined;
  if (!projection) {
    projection = connectProjection(bridge, initialState, reduce);
    projections.set(bridge, projection);
  }
  return projection;
}

/**
 * The provider connects the bridge once and mounts the harness's view — behind the installer, for as long as
 * the run is acquiring what it needs. A harness writes nothing for that: acquiring weights is the platform's
 * business, and the screen for it is the platform's too.
 */
export function HarnessProvider<E, C, S extends object>({ bridge, initialState, reduce, children }: {
  bridge: Bridge<E, C, S>;
  initialState: S;
  reduce: (state: S, ev: E) => S;
  children: ReactNode;
}): ReactElement {
  const value = useMemo<Harness<E, C, S>>(() => ({ bridge, projection: projectionFor(bridge, initialState, reduce) }), [bridge]);
  return createElement(HarnessContext.Provider, { value: value as Harness<unknown, unknown, object> }, createElement(Acquiring, null, children));
}

/** The installer while the run acquires; the harness's view once it is done — or at once, on a run that acquires nothing. */
function Acquiring({ children }: { children: ReactNode }): ReactElement {
  const steps = useInstall();
  const send = useSend<{ type: string; step?: string; path?: string }>();
  const chooseFile = useChooseFile();
  if (steps.length === 0) return createElement(Fragment, null, children);
  return createElement(Installer, {
    steps,
    footnote: 'First run only',
    onRetry: () => send({ type: 'install:retry' }),
    onStop: () => send({ type: 'install:quit' }),
    ...(chooseFile ? {
      onUseFile: (step: string) => {
        void chooseFile({ extensions: ['gguf'], title: 'Choose a model file' }).then((path) => {
          if (path) send({ type: 'install:use_file', step, path });
        });
      },
    } : {}),
  });
}

/** The provider's bridge and projection, for a consumer outside the hooks (a history adapter). */
export function useHarness<E = unknown, C = unknown, S extends object = object>(): Harness<E, C, S> {
  const h = useContext(HarnessContext);
  if (!h) throw new Error('useHarness: no HarnessProvider above this component');
  return h as Harness<E, C, S>;
}

const derived = new WeakMap<object, Map<(s: never) => unknown, unknown>>();

/** Read a derivation of the folded state, memoized per fold. */
export function useProjection<S extends object, T>(select: (state: S) => T): T {
  const { projection } = useHarness<unknown, unknown, S>();
  const read = (): T => {
    const state = projection.getSnapshot();
    let memo = derived.get(state);
    if (!memo) {
      memo = new Map();
      derived.set(state, memo);
    }
    const key = select as unknown as (s: never) => unknown;
    if (!memo.has(key)) memo.set(key, select(state));
    return memo.get(key) as T;
  };
  return useSyncExternalStore(projection.subscribe, read, read);
}

/** Dispatch a command to the harness. */
export function useSend<C>(): (command: C) => void {
  const { bridge } = useHarness<unknown, C, object>();
  return bridge.send;
}

interface WireStore {
  subscribe: (notify: () => void) => () => void;
  getSnapshot: () => WireStatus;
}

/** One status per bridge, for the life of the page. React reads `getSnapshot`
 *  during render, so the status it reads must outlive the render that reads it:
 *  the bridge is told once, here, and every renderer of it shares that one
 *  answer. A bridge without `onStatus` (in-process) never leaves 'connected'. */
const statuses = new WeakMap<object, WireStore>();

function statusFor(bridge: Bridge<unknown, unknown, unknown>): WireStore {
  let store = statuses.get(bridge);
  if (!store) {
    let status: WireStatus = 'connected';
    const listeners = new Set<() => void>();
    bridge.onStatus?.((next) => {
      status = next;
      for (const notify of listeners) notify();
    });
    store = {
      subscribe(notify) {
        listeners.add(notify);
        return () => { listeners.delete(notify); };
      },
      getSnapshot: () => status,
    };
    statuses.set(bridge, store);
  }
  return store;
}

/** The status a server render reads: no wire has been asked yet. */
const connected = (): WireStatus => 'connected';

/** The wire's status. A bridge without `onStatus` (in-process) reads 'connected' forever. */
export function useConnection(): WireStatus {
  const { bridge } = useHarness();
  const wire = statusFor(bridge);
  return useSyncExternalStore(wire.subscribe, wire.getSnapshot, connected);
}

interface AvailabilityStore {
  subscribe: (notify: () => void) => () => void;
  getSnapshot: () => Availability;
}

/** One derivation per bridge, for the life of the page — the same reason the status has one. */
const availabilities = new WeakMap<object, AvailabilityStore>();

function availabilityFor(bridge: Bridge<unknown, unknown, unknown>): AvailabilityStore {
  let store = availabilities.get(bridge);
  if (!store) {
    // A bridge with no droppable link is up, and one with no session plane has a single implicit
    // session that is live: nothing queues it and nothing reaps it, so "waiting" and "ended" are not
    // states it can be in. This is the ONE place a placement difference is stated; the derivation
    // itself knows no placements.
    let wire: WireStatus = 'connected';
    let session: SessionState | null = bridge.onSession ? null : { phase: 'live' };
    let value = availabilityOf(session, wire);
    const listeners = new Set<() => void>();
    const settle = (): void => {
      const next = availabilityOf(session, wire);
      if (next === value) return;
      value = next;
      for (const notify of listeners) notify();
    };
    bridge.onStatus?.((next) => { wire = next; settle(); });
    bridge.onSession?.((next) => { session = next; settle(); });
    store = {
      subscribe(notify) {
        listeners.add(notify);
        return () => { listeners.delete(notify); };
      },
      getSnapshot: () => value,
    };
    availabilities.set(bridge, store);
  }
  return store;
}

/** What a server render reads: nothing has been asked of either plane yet. */
const starting = (): Availability => 'connecting';

/**
 * Whether this harness can take work, and if not, why — the question a view actually asks.
 *
 * Derived from the transport's status and the host's session phase, because neither answers it
 * alone: a queued reader's socket is healthy, and an ended session is followed by a close that
 * reads as a network failure. Prefer this to {@link useConnection}, which is the transport fact
 * on its own.
 */
export function useAvailability(): Availability {
  const { bridge } = useHarness();
  const store = availabilityFor(bridge);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, starting);
}

/**
 * Ask the placement for a working harness — or null where this bridge cannot provide one.
 *
 * A view knows WHEN recovery is wanted and never what it costs: a browser opens a new connection
 * because a served host cannot re-admit an existing one; a desktop shell starts a new engine while
 * its renderer's IPC link stays up throughout. Same button, different price, and the view pays
 * neither.
 */
export function useRecover(): (() => void) | null {
  const { bridge } = useHarness();
  return useMemo(() => (bridge.recover ? (): void => bridge.recover!() : null), [bridge]);
}

/**
 * What this run is acquiring before it can work — the install, read off the platform's own stream.
 *
 * Deliberately NOT folded into a harness's state. Acquiring weights is the platform's business, like the
 * wire's status and the session's phase: a harness that had to declare the event in its union and fold it in
 * its reducer could miswire or delete either, and the experience would differ per harness for no reason.
 *
 * Two sources, because one is not enough. The push is an ordinary frame, so a running install self-heals:
 * every change carries the whole list, and the next tick catches a late subscriber up. A REFUSAL does not —
 * the gate reports once and the run ends — so the placement is also asked what it is holding, exactly as
 * `onSession` is paired with a "now" channel. Empty on every run that acquires nothing.
 */
export function useInstall(): readonly InstallerStep[] {
  const { bridge } = useHarness();
  const [steps, setSteps] = useState<readonly InstallerStep[]>([]);
  useEffect(() => {
    let live = true;
    const take = (ev: unknown): void => {
      const e = ev as { type?: unknown; steps?: readonly InstallerStep[] };
      if (live && e && e.type === 'install:step' && Array.isArray(e.steps)) setSteps(e.steps);
    };
    const off = bridge.onEvent((frame) => take(frame.ev));
    void bridge.installNow?.().then(take).catch(() => { /* a placement that cannot answer has nothing to report */ });
    return () => {
      live = false;
      off();
    };
  }, [bridge]);
  return steps;
}

/** What a placement's file chooser takes, and answers. */
export type ChooseFileOpts = { extensions?: readonly string[]; title?: string };
export type ChooseFile = (opts?: ChooseFileOpts) => Promise<string | null>;

/**
 * Choose a local file, or null on a bridge that cannot — which a browser cannot, since a page is handed bytes
 * and never a path. A view offers the affordance only when this is non-null.
 */
export function useChooseFile(): ChooseFile | null {
  const { bridge } = useHarness();
  return useMemo(() => (bridge.chooseFile ? (opts?: ChooseFileOpts) => bridge.chooseFile!(opts) : null), [bridge]);
}

/** The content plane's origin, or null on a bridge without one. */
export function useContentOrigin(): string | null {
  const { bridge } = useHarness();
  return bridge.contentOrigin?.() ?? null;
}
