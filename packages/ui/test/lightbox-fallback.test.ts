// @vitest-environment jsdom
/**
 * A player that fails never takes the page with it: the lightbox falls back to
 * the browser's own video element, playing the same file from the same moment.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Lightbox } from '../src/lightbox';

vi.mock('../src/provider.js', () => ({ useContentOrigin: () => 'http://host' }));
vi.mock('../src/video-player.js', () => ({ VideoPlayer: () => { throw new Error('Invalid URL'); } }));

describe('the video lightbox when the player fails', () => {
  beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

  it('plays the file in the browser\'s own player instead of blanking the page', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = document.createElement('div');
    const root = createRoot(container);
    const video = { src: 'http://host/source', durationMs: 9000, frames: [{ tMs: 0, src: 'http://host/f0' }], atMs: 5000 };
    await act(async () => { root.render(createElement(Lightbox, { video, onClose: () => {} })); });
    await act(async () => { await import('../src/video-player.js'); });
    const fallback = container.querySelector('video')!;
    expect(fallback.getAttribute('src')).toBe('http://host/source');
    expect(fallback.controls).toBe(true);
    act(() => { fallback.dispatchEvent(new Event('loadedmetadata')); });
    expect(fallback.currentTime).toBe(5);
    act(() => root.unmount());
  });
});
