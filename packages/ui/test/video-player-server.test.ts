/**
 * The player and the lightbox render on a server, where there is no `document`.
 *
 * No `@vitest-environment` pragma: this file runs in Node, as a server render
 * does. The track URLs are files a page makes once it has mounted, so a render
 * with no page simply has none yet; what it must never do is reach for the
 * page while rendering and throw.
 */
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { VideoPlayer } from '../src/video-player';
import { Lightbox } from '../src/lightbox';
import type { VideoView } from '../src/video-view';

// The lightbox reads the content origin from the provider, as its own tests arrange.
vi.mock('../src/provider.js', () => ({ useContentOrigin: () => 'http://host' }));

const video: VideoView & { src: string } = {
  durationMs: 9000,
  poster: 'http://host/f0',
  frames: [{ tMs: 0, src: 'http://host/f0' }],
  src: 'http://host/source',
  transcript: [{ startMs: 0, endMs: 4000, text: 'a sentence' }],
};

describe('rendering with no document', () => {
  it('the player renders its video element and no tracks', () => {
    expect(typeof document).toBe('undefined');
    const html = renderToString(createElement(VideoPlayer, { video }));
    expect(html).toContain('<video');
    expect(html).not.toContain('<track');
  });

  it('the lightbox renders its dialog without reaching for the page', () => {
    // The player inside it loads lazily once a video is first opened, so the server string holds the dialog.
    const html = renderToString(createElement(Lightbox, { video, label: 'the attached video', onClose: () => {} }));
    expect(html).toContain('<dialog');
  });
});
