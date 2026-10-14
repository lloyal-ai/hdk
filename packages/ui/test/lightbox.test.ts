// @vitest-environment jsdom
/**
 * The video lightbox: with the original kept, a player whose time slider
 * carries the frames the model saw, the transcript as captions, and a cited
 * moment as where it opens; without it, the frames themselves, each with its
 * time.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Lightbox } from '../src/lightbox';
import { VideoCard } from '../src/video-card';
import type { VideoView } from '../src/video-view';

vi.mock('../src/provider.js', () => ({ useContentOrigin: () => 'http://host' }));

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

  it('lets go of its track files when it closes', async () => {
    await show({ ...view, src: 'http://host/source' });
    expect(made).toHaveLength(2);
    act(() => root.unmount());
    expect(made).toHaveLength(0);
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
