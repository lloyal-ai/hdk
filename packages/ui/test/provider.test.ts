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
