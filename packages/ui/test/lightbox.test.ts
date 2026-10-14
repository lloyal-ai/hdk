// @vitest-environment jsdom
/**
 * The video lightbox: with the original kept, a player whose time slider
 * carries the frames the model saw, the transcript as captions, and a cited
 * moment as where it opens; without it, the frames themselves, each with its
 * time.
 */
import { StrictMode, act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Lightbox } from '../src/lightbox';
import { VideoCard } from '../src/video-card';
import type { VideoView } from '../src/video-view';

vi.mock('../src/provider.js', () => ({ useContentOrigin: () => 'http://host' }));

/** jsdom has no modal dialogs: these record what a browser does, and the browser keeps Tab inside. */
const opened: HTMLDialogElement[] = [];
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { opened.push(this); this.setAttribute('open', ''); };
HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };

const view: VideoView = {
  durationMs: 9000,
  poster: 'http://host/f0',
  frames: [{ tMs: 0, src: 'http://host/f0' }, { tMs: 5000, src: 'http://host/f1' }],
  transcript: [{ startMs: 0, endMs: 5000, text: 'one, two, three' }],
};

describe('the video lightbox', () => {
  let root: Root;
  let container: HTMLDivElement;
  const made: string[] = [];
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // jsdom has no object URLs; each track's blob is recorded instead.
    let n = 0;
    URL.createObjectURL = () => { const url = `blob:track-${n++}`; made.push(url); return url; };
    URL.revokeObjectURL = (url: string) => { made.splice(made.indexOf(url), 1); };
  });
  afterEach(() => { act(() => root?.unmount()); container?.remove(); });
  /** Renders the lightbox and waits for the player, which loads when a video is first opened. */
  const show = async (video: VideoView): Promise<void> => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root.render(createElement(Lightbox, { video, onClose: () => {} })); });
    await act(async () => { await import('../src/video-player'); });
  };

  it('plays the original with the frames, the transcript and the cited moment as its tracks', async () => {
    await show({ ...view, src: 'http://host/source', atMs: 5000 });
    const player = container.querySelector('video')!;
    expect(player.getAttribute('src')).toBe('http://host/source');
    expect(player.crossOrigin).toBe('anonymous');
    const tracks = [...player.querySelectorAll('track')].map((t) => [t.kind, t.label, t.default]);
    expect(tracks).toEqual([['metadata', 'thumbnails', true], ['captions', 'Transcript', true], ['chapters', 'Chapters', true]]);
    act(() => { player.dispatchEvent(new Event('loadedmetadata')); });
    expect(player.currentTime).toBe(5);
    expect(container.textContent).toContain('from 0:05');
  });

  it('opens at the cited moment even when the media had its metadata before the player looked', async () => {
    const proto = HTMLMediaElement.prototype;
    const ready = Object.getOwnPropertyDescriptor(proto, 'readyState')!;
    Object.defineProperty(proto, 'readyState', { configurable: true, get: () => 1 });
    try {
      await show({ ...view, src: 'http://host/source', atMs: 5000 });
      expect(container.querySelector('video')!.currentTime).toBe(5);
    } finally {
      Object.defineProperty(proto, 'readyState', ready);
    }
  });

  it('recovers when the browser cannot open its audio output: reloads at the same moment and plays on', async () => {
    await show({ ...view, src: 'http://host/source' });
    const player = container.querySelector('video')!;
    const load = vi.spyOn(player, 'load').mockImplementation(() => {});
    const play = vi.spyOn(player, 'play').mockResolvedValue(undefined);
    player.currentTime = 2;
    Object.defineProperty(player, 'error', { configurable: true, get: () => ({ code: 3, message: 'PipelineStatus::AUDIO_RENDERER_ERROR: audio render error' }) });
    act(() => { player.dispatchEvent(new Event('error')); });
    expect(load).toHaveBeenCalledOnce();
    act(() => { player.dispatchEvent(new Event('loadedmetadata')); });
    expect(player.currentTime).toBe(2);
    expect(play).toHaveBeenCalledOnce();
    expect(player.muted).toBe(false);
    // A second failure in a row: the device is still unavailable, so the video goes on without sound.
    act(() => { player.dispatchEvent(new Event('error')); });
    act(() => { player.dispatchEvent(new Event('loadedmetadata')); });
    expect(player.muted).toBe(true);
  });

  it('keeps its tracks pointing at live files under StrictMode, which sets effects up, tears them down, and sets them up again', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root.render(createElement(StrictMode, null, createElement(Lightbox, { video: { ...view, src: 'http://host/source' }, onClose: () => {} }))); });
    await act(async () => { await import('../src/video-player'); });
    const sources = [...container.querySelectorAll('track')].map((t) => t.getAttribute('src'));
    expect(sources).toHaveLength(2);
    for (const src of sources) expect(made).toContain(src);
  });

  it('lets go of its track files when it closes', async () => {
    await show({ ...view, src: 'http://host/source' });
    expect(made).toHaveLength(2);
    act(() => root.unmount());
    expect(made).toHaveLength(0);
  });

  it('says a cited moment to the fraction of a second, so nearby moments read apart', async () => {
    await show({ ...view, src: 'http://host/source', atMs: 250 });
    expect(container.textContent).toContain('from 0:00.25');
  });

  it('without the original, shows the frames the model saw, each with its time', async () => {
    await show(view);
    expect(container.querySelector('video')).toBeNull();
    expect([...container.querySelectorAll('figcaption')].map((c) => c.textContent)).toEqual(['0:00', '0:05']);
  });
});

describe('the video card', () => {
  it('shows the poster with its length, and opens on a click', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const open = vi.fn();
    act(() => root.render(createElement(VideoCard, { video: { ...view, src: 'http://host/source', durationMs: 3_725_000 }, onOpen: open })));
    const card = container.querySelector('button')!;
    expect(card.getAttribute('aria-label')).toBe('Play the attached video, 1:02:05');
    expect(container.querySelector('img')!.getAttribute('src')).toBe('http://host/f0');
    expect(card.textContent).toBe('1:02:05');
    act(() => card.click());
    expect(open).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });
});

describe('the lightbox as a modal', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    URL.createObjectURL ??= () => 'blob:track';
    URL.revokeObjectURL ??= () => {};
  });
  const kinds = {
    image: { digest: `sha256:${'a'.repeat(64)}` },
    document: { pdf: 'http://host/source' },
    video: { video: { ...view, src: 'http://host/source' } },
  };

  for (const [kind, props] of Object.entries(kinds)) {
    it(`opens ${kind === 'image' ? 'an' : 'a'} ${kind} as a modal dialog: Escape closes it, and focus goes back to what opened it`, async () => {
      const opener = document.createElement('button');
      document.body.append(opener);
      opener.focus();
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      const onClose = vi.fn();
      opened.length = 0;
      await act(async () => { root.render(createElement(Lightbox, { ...props, onClose })); });
      const dialog = container.querySelector('dialog')!;
      expect(opened).toEqual([dialog]);
      expect(dialog.getAttribute('aria-label')).toBeTruthy();
      const escape = new Event('cancel', { cancelable: true });
      act(() => { dialog.dispatchEvent(escape); });
      expect(onClose).toHaveBeenCalledOnce();
      // The caller closes it, by unmounting; the browser alone would leave React's tree behind.
      expect(escape.defaultPrevented).toBe(true);
      act(() => root.unmount());
      expect(document.activeElement).toBe(opener);
      container.remove();
      opener.remove();
    });
  }
});
