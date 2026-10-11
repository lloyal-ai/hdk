// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Popover } from '../src/popover';

/** A control and the surface it owns, the way a composer would hold them. */
function Host({ child = createElement('button', { 'aria-label': 'web' }, 'web') }: { child?: ReturnType<typeof createElement> } = {}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return createElement('div', null,
    createElement('button', { ref: setAnchor, 'aria-label': 'Abilities', onClick: () => setOpen(true) }, 'abilities'),
    createElement('p', { id: 'outside' }, 'elsewhere'),
    createElement(Popover, {
      anchor, open, onClose: () => setOpen(false), label: 'Abilities',
      children: child,
    }),
  );
}

describe('a popover over the page', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
  afterEach(() => { act(() => root?.unmount()); container?.remove(); });

  const dialog = () => document.body.querySelector('[role="dialog"][aria-label="Abilities"]');

  it('floats in the document body, above its anchor, and takes focus; Escape and an outside press close it and hand focus back', async () => {
    container = document.createElement('div'); document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(Host)));
    const anchor = container.querySelector<HTMLButtonElement>('[aria-label="Abilities"]')!;
    expect(dialog()).toBeNull();
    await act(async () => anchor.click());
    const panel = dialog() as HTMLElement;
    expect(panel).not.toBeNull();
    expect(container.contains(panel)).toBe(false);
    expect(panel.style.position).toBe('fixed');
    expect(panel.style.bottom).not.toBe('');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('web');
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(anchor);
    await act(async () => anchor.click());
    expect(dialog()).not.toBeNull();
    await act(async () => { panel.querySelector('button')!.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    await act(async () => { dialog()!.querySelector('button')!.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(dialog()).not.toBeNull();
    await act(async () => { document.getElementById('outside')!.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(dialog()).toBeNull();
  });

  it('hands focus to the first native control of any kind, and to itself when it holds none', async () => {
    const open = async (child: ReturnType<typeof createElement>) => {
      container = document.createElement('div'); document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => root.render(createElement(Host, { child })));
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Abilities"]')!.click());
    };
    await open(createElement('a', { href: '#settings', 'aria-label': 'settings' }, 'settings'));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('settings');
    await act(async () => root.unmount()); container.remove();
    await open(createElement('p', null, 'nothing to press'));
    expect(document.activeElement).toBe(dialog());
  });
});
