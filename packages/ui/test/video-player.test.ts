// @vitest-environment jsdom
/**
 * The player reopens the audio output after Chromium's AUDIO_RENDERER_ERROR,
 * and the recovery it starts belongs to the player that started it: a player
 * gone before the media reloads never resumes playback.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { VideoPlayer } from '../src/video-player';
import type { VideoView } from '../src/video-view';

const video: VideoView & { src: string } = {
  durationMs: 9000,
  poster: 'http://host/f0',
  frames: [{ tMs: 0, src: 'http://host/f0' }],
  src: 'http://host/source',
};

describe('audio output recovery', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    URL.createObjectURL = () => 'blob:track';
    URL.revokeObjectURL = () => {};
  });

  /** A mounted player whose media fails with Chromium's audio-renderer error, and the spies a reload would reach. */
  async function failingPlayer() {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => { root.render(createElement(VideoPlayer, { video })); });
    const element = container.querySelector('video')!;
    Object.defineProperty(element, 'error', { configurable: true, get: () => ({ message: 'AUDIO_RENDERER_ERROR: output device lost' }) });
    const load = vi.spyOn(element, 'load').mockImplementation(() => {});
    const play = vi.spyOn(element, 'play').mockImplementation(() => Promise.resolve());
    return { root, element, load, play };
  }

  it('reloads and plays on from the same moment', async () => {
    const { root, element, load, play } = await failingPlayer();
    element.dispatchEvent(new Event('error'));
    expect(load).toHaveBeenCalledTimes(1);
    element.dispatchEvent(new Event('loadedmetadata'));
    expect(play).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it('never resumes playback once the player is gone', async () => {
    const { root, element, play } = await failingPlayer();
    element.dispatchEvent(new Event('error'));
    await act(async () => root.unmount());
    element.dispatchEvent(new Event('loadedmetadata'));
    expect(play).not.toHaveBeenCalled();
  });
});
