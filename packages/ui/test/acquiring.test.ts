// @vitest-environment jsdom
/**
 * The provider and the installer together, in a DOM: what a reader is offered when the engine behind the
 * steps ends. Rendered with React's `act`, because the install and the session are read in effects that a
 * server render never runs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { Bridge, Frame, SessionState } from '@lloyal-labs/binding';
import { HarnessProvider } from '../src/provider';
import type { InstallerStep } from '../src/installer';

type S = { n: number };

/** A desktop-shaped bridge: a session plane, an install to ask, a new engine on offer. */
function desktopBridge(now: readonly InstallerStep[]): Bridge<unknown, unknown, S> & {
  push(steps: readonly InstallerStep[]): void;
  session(state: SessionState): void;
  recovered: number;
} {
  const events = new Set<(f: Frame<unknown>) => void>();
  const sessions = new Set<(s: SessionState) => void>();
  let seq = 0;
  return {
    recovered: 0,
    onEvent(cb) { events.add(cb); return () => events.delete(cb); },
    onSession(cb) { sessions.add(cb); return () => sessions.delete(cb); },
    send() {},
    requestSnapshot: () => Promise.resolve({ state: { n: 0 }, epoch: 1, seq }),
    installNow: () => Promise.resolve({ type: 'install:step', steps: now }),
    chooseFile: () => Promise.resolve(null),
    recover() { this.recovered += 1; },
    push(steps) { seq += 1; for (const cb of events) cb({ epoch: 1, seq, ev: { type: 'install:step', steps } }); },
    session(state) { for (const cb of sessions) cb(state); },
  };
}

const running: InstallerStep[] = [
  { id: 'machine', label: 'This machine', status: 'done', note: '16 GB · 10 GB needed' },
  { id: 'llm', label: 'Getting the model', status: 'running', got: 1024 ** 3, total: 2 * 1024 ** 3, file: true },
  { id: 'reranker', label: 'Getting the reranker', status: 'pending', file: true },
];

const flush = (): Promise<void> => act(async () => { await Promise.resolve(); });

describe('the install view when the engine ends', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

  function mount(bridge: Bridge<unknown, unknown, S>): void {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(createElement(HarnessProvider, { bridge, initialState: { n: 0 }, reduce: (s: S) => s }, createElement('main', null, 'the app')));
    });
  }

  it('an engine that dies under a download: the step it died under has failed, and a new engine is the one thing offered', async () => {
    const bridge = desktopBridge(running);
    mount(bridge);
    await flush();
    expect(container.textContent).toContain('STEP 2 OF 3');
    expect(container.querySelectorAll('button').length).toBeGreaterThan(0);   // live: use a file
    act(() => bridge.session({ phase: 'died', code: 1 }));
    expect(container.textContent).toContain('The engine ended');
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toEqual(['Start a new engine']);
    expect(container.textContent).toContain('STOPPED AT STEP 2');
    act(() => { (container.querySelector('button') as HTMLButtonElement).click(); });
    expect(bridge.recovered).toBe(1);
    act(() => root.unmount());
  });

  it('a machine this model cannot run on: the refusal, and nothing a new engine would repeat', async () => {
    const refused: InstallerStep[] = [
      { id: 'machine', label: 'This machine', status: 'failed', note: 'Run this harness on a machine with at least 16 GB.' },
      { id: 'llm', label: 'Getting the model', status: 'pending', file: true },
    ];
    const bridge = desktopBridge(refused);
    mount(bridge);
    await flush();
    act(() => bridge.session({ phase: 'died', code: 1 }));
    expect(container.textContent).toContain('This machine cannot run this model');
    expect(container.querySelectorAll('button').length).toBe(0);
    act(() => root.unmount());
  });

  it('a new engine that acquires nothing: the steps clear at warming and the app is shown', async () => {
    const bridge = desktopBridge(running);
    mount(bridge);
    await flush();
    act(() => bridge.session({ phase: 'died', code: 1 }));
    bridge.installNow = () => Promise.resolve({ type: 'install:step', steps: [] });
    act(() => bridge.session({ phase: 'warming' }));
    await flush();
    expect(container.textContent).toBe('the app');
    act(() => root.unmount());
  });
});
