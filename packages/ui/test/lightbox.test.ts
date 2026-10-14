// @vitest-environment jsdom
/**
 * The video lightbox: with the original kept, each frame the model saw is a
 * control that plays from its moment, reachable by keyboard like any button.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Lightbox } from '../src/lightbox';

vi.mock('../src/provider.js', () => ({ useContentOrigin: () => 'http://host' }));

const frames = [{ tMs: 0, src: 'http://host/f0' }, { tMs: 5000, src: 'http://host/f1' }];

describe('the video lightbox', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
  afterEach(() => { act(() => root?.unmount()); container?.remove(); });
  const show = (video: Parameters<typeof Lightbox>[0]['video']): void => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(createElement(Lightbox, { video, onClose: () => {} })));
  };

  it('each frame is a button that seeks the original to its moment', () => {
    show({ src: 'http://host/source', frames });
    const seeks = [...container.querySelectorAll('button')];
    expect(seeks.map((b) => b.getAttribute('aria-label'))).toEqual(['Play from 0:00', 'Play from 0:05']);
    const player = container.querySelector('video')!;
    act(() => seeks[1].click());
    expect(player.currentTime).toBe(5);
  });

  it('without the original, a frame is only a picture', () => {
    show({ frames });
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelectorAll('img')).toHaveLength(2);
  });
});
