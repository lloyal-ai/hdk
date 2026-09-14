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
 * @category UI
 */
import { createContext, createElement, useContext, useMemo, useSyncExternalStore } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { connectProjection } from '@lloyal-labs/binding';
import type { Bridge, Projection, WireStatus } from '@lloyal-labs/binding';

export interface Harness<E, C, S> {
  bridge: Bridge<E, C, S>;
  projection: Projection<S>;
}

const HarnessContext = createContext<Harness<unknown, unknown, unknown> | null>(null);

/** One projection per bridge, for the life of the page: a React remount under the same bridge reattaches. */
const projections = new WeakMap<object, Projection<unknown>>();

/** The one projection over a bridge — the provider's, shared with a consumer outside React (a history adapter). */
export function projectionFor<E, C, S>(bridge: Bridge<E, C, S>, initialState: S, reduce: (state: S, ev: E) => S): Projection<S> {
  let projection = projections.get(bridge) as Projection<S> | undefined;
  if (!projection) {
    projection = connectProjection(bridge, initialState, reduce);
    projections.set(bridge, projection);
  }
  return projection;
}

export function HarnessProvider<E, C, S>({ bridge, initialState, reduce, children }: {
  bridge: Bridge<E, C, S>;
  initialState: S;
  reduce: (state: S, ev: E) => S;
  children: ReactNode;
}): ReactElement {
  const value = useMemo<Harness<E, C, S>>(() => ({ bridge, projection: projectionFor(bridge, initialState, reduce) }), [bridge]);
  return createElement(HarnessContext.Provider, { value: value as Harness<unknown, unknown, unknown> }, children);
}

/** The provider's bridge and projection, for a consumer outside the hooks (a history adapter). */
export function useHarness<E = unknown, C = unknown, S = unknown>(): Harness<E, C, S> {
  const h = useContext(HarnessContext);
  if (!h) throw new Error('useHarness: no HarnessProvider above this component');
  return h as Harness<E, C, S>;
}

const derived = new WeakMap<object, Map<(s: never) => unknown, unknown>>();

/** Read a derivation of the folded state, memoized per fold. */
export function useProjection<S, T>(select: (state: S) => T): T {
  const { projection } = useHarness<unknown, unknown, S>();
  const read = (): T => {
    const state = projection.getSnapshot() as unknown as object;
    let memo = derived.get(state);
    if (!memo) {
      memo = new Map();
      derived.set(state, memo);
    }
    const key = select as unknown as (s: never) => unknown;
    if (!memo.has(key)) memo.set(key, select(state as unknown as S));
    return memo.get(key) as T;
  };
  return useSyncExternalStore(projection.subscribe, read, read);
}

/** Dispatch a command to the harness. */
export function useSend<C>(): (command: C) => void {
  const { bridge } = useHarness<unknown, C, unknown>();
  return bridge.send;
}

/** The wire's status. A bridge without `onStatus` (in-process) reads 'connected' forever. */
export function useConnection(): WireStatus {
  const { bridge } = useHarness();
  let last: WireStatus = 'connected';
  return useSyncExternalStore(
    (notify) => bridge.onStatus?.((s) => { last = s; notify(); }) ?? (() => {}),
    () => last,
    () => 'connected',
  );
}

/** The content plane's origin, or null on a bridge without one. */
export function useContentOrigin(): string | null {
  const { bridge } = useHarness();
  return bridge.contentOrigin?.() ?? null;
}
