/**
 * What the model saw, said as the standard tracks a player reads: the sampled
 * frames as the time slider's thumbnails, the transcript as captions, and a
 * cited moment as the chapter that starts there.
 */
import { describe, expect, it } from 'vitest';
import { representationUrl, sourceUrl } from '@lloyal-labs/media';
import type { VideoMeta } from '@lloyal-labs/media';
import { videoTracks, videoView } from '../src/video-view';

const view = {
  src: 'http://host/v1/media/sha256:aa/source',
  poster: 'http://host/f0.jpg',
  durationMs: 1250,
  size: { width: 320, height: 240 },
  frames: [{ src: 'http://host/f0.jpg', tMs: 0 }, { src: 'http://host/f1.jpg', tMs: 500 }, { src: 'http://host/f2.jpg', tMs: 1000 }],
  transcript: [{ startMs: 0, endMs: 1250, text: 'one, two --> three & <four>' }],
};

describe('videoTracks', () => {
  it('gives each frame the model saw the span until the next one, sized for the preview', () => {
    expect(videoTracks(view).thumbnails).toBe([
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:00.500',
      'http://host/f0.jpg#xywh=0,0,320,240',
      '',
      '00:00:00.500 --> 00:00:01.000',
      'http://host/f1.jpg#xywh=0,0,320,240',
      '',
      '00:00:01.000 --> 00:00:01.250',
      'http://host/f2.jpg#xywh=0,0,320,240',
      '',
    ].join('\n'));
  });

  it('says the transcript as captions, escaped so a line cannot end its cue', () => {
    expect(videoTracks(view).captions).toBe([
      'WEBVTT', '', '00:00:00.000 --> 00:00:01.250', 'one, two --&gt; three &amp; &lt;four&gt;', '',
    ].join('\n'));
    expect(videoTracks({ ...view, transcript: undefined }).captions).toBeUndefined();
  });

  it('starts a chapter at a cited moment, so the time slider breaks there', () => {
    expect(videoTracks({ ...view, atMs: 500 }).chapters).toBe([
      'WEBVTT', '', '00:00:00.000 --> 00:00:00.500', 'the clip', '', '00:00:00.500 --> 00:00:01.250', 'cited in the report', '',
    ].join('\n'));
    expect(videoTracks(view).chapters).toBeUndefined();
    expect(videoTracks({ ...view, atMs: 0 }).chapters).toBeUndefined();
    expect(videoTracks({ ...view, atMs: 5000 }).chapters).toBeUndefined();
  });

  it('writes each frame\'s address whole, since a player reads it against the track\'s own blob: address', () => {
    const relative = { ...view, frames: [{ src: '/v1/media/x/representations/0', tMs: 0 }] };
    expect(videoTracks(relative, 'http://localhost:5173/').thumbnails)
      .toContain('\nhttp://localhost:5173/v1/media/x/representations/0#xywh=0,0,320,240\n');
  });

  it('writes hours, minutes and milliseconds the way WebVTT reads them', () => {
    const long = videoTracks({ ...view, durationMs: 3_725_042, frames: [{ src: 'f', tMs: 3_600_000 }], size: undefined });
    expect(long.thumbnails).toContain('01:00:00.000 --> 01:02:05.042\nf\n');
  });
});

describe('videoView', () => {
  const meta: VideoMeta = {
    width: 320, height: 240, durationMs: 1250, poster: 1,
    frames: [{ tMs: 0, frame: 0 }, { tMs: 500, frame: 1 }],
    sampling: { fps: 4, timestampIntervalMs: 5000, maxFrames: 64 },
  };
  const digest = `sha256:${'a'.repeat(64)}`;

  it('reads a composed video as the player shows it: its original, poster, frames and transcript', () => {
    const transcript = { provenance: {}, segments: [{ startMs: 0, endMs: 1250, text: 'hello' }] };
    const v = videoView('http://host', digest, { kind: 'video', meta, source: true, transcript }, 500);
    expect(v.src).toBe(sourceUrl('http://host', digest));
    expect(v.poster).toBe(representationUrl('http://host', digest, 1));
    expect(v.frames).toEqual([
      { src: representationUrl('http://host', digest, 0), tMs: 0 },
      { src: representationUrl('http://host', digest, 1), tMs: 500 },
    ]);
    expect(v).toMatchObject({ durationMs: 1250, size: { width: 320, height: 240 }, transcript: transcript.segments, atMs: 500 });
  });

  it('has nothing to play when the original was not kept', () => {
    expect(videoView('http://host', digest, { kind: 'video', meta, source: false }).src).toBeUndefined();
  });
});
