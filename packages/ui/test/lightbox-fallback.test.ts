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
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };

describe('the video lightbox when the player fails', () => {
  const live = new Set<string>();
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // jsdom has no object URLs; each track's blob is recorded instead.
    let n = 0;
    URL.createObjectURL = () => { const url = `blob:track-${n++}`; live.add(url); return url; };
    URL.revokeObjectURL = (url: string) => { live.delete(url); };
  });

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

  it('moves to another cited moment of the same file in the browser\'s own player', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = document.createElement('div');
    const root = createRoot(container);
    const video = { src: 'http://host/source', durationMs: 9000, frames: [{ tMs: 0, src: 'http://host/f0' }], atMs: 5000 };
    await act(async () => { root.render(createElement(Lightbox, { video, onClose: () => {} })); });
    await act(async () => { await import('../src/video-player.js'); });
    const fallback = container.querySelector('video')!;
    act(() => { fallback.dispatchEvent(new Event('loadedmetadata')); });
    // The file is loaded: a new moment of it fires no second `loadedmetadata`.
    Object.defineProperty(fallback, 'readyState', { configurable: true, get: () => HTMLMediaElement.HAVE_METADATA });
    await act(async () => { root.render(createElement(Lightbox, { video: { ...video, atMs: 7000 }, onClose: () => {} })); });
    expect(container.querySelector('video')).toBe(fallback);
    expect(fallback.currentTime).toBe(7);
    act(() => root.unmount());
  });

  it('keeps the transcript as captions in the browser\'s own player, and lets go of the file when it closes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = document.createElement('div');
    const root = createRoot(container);
    const video = {
      src: 'http://host/source', durationMs: 9000, frames: [{ tMs: 0, src: 'http://host/f0' }],
      transcript: [{ startMs: 0, endMs: 5000, text: 'one, two, three' }],
    };
    await act(async () => { root.render(createElement(Lightbox, { video, onClose: () => {} })); });
    await act(async () => { await import('../src/video-player.js'); });
    const captions = container.querySelector('video track[kind="captions"]')!;
    expect(captions).not.toBeNull();
    expect(captions.getAttribute('label')).toBe('Transcript');
    expect(live).toContain(captions.getAttribute('src'));
    act(() => root.unmount());
    expect(live.size).toBe(0);
  });
});
