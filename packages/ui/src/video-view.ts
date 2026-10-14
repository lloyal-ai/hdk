/**
 * A composed video as a player shows it, and what the model saw said as the
 * standard tracks a player reads: the sampled frames as the time slider's
 * thumbnails, the transcript as captions, and a cited moment as the chapter
 * that starts there. Pure, so the tracks are known before anything plays.
 *
 * @category UI
 */
import { representationUrl, sourceUrl } from '@lloyal-labs/media';
import type { Asset } from './assets.js';

/** One video, ready to play: its original when kept, and the frames and transcript the model was given. */
export interface VideoView {
  /** The original, when it was kept; without it there is nothing to play, only the frames. */
  src?: string;
  /** The frame the clip is shown by before it plays. */
  poster?: string;
  durationMs: number;
  /** The frames' pixel size, which sizes the time slider's preview. */
  size?: { width: number; height: number };
  /** The frames the model saw, each at the time it was shown. */
  frames: { src: string; tMs: number }[];
  /** What the soundtrack said, window by window. */
  transcript?: { startMs: number; endMs: number; text: string }[];
  /** Where to start: a cited moment. */
  atMs?: number;
}

/** The composed video at `digest`, as a player shows it; `atMs` opens it at a cited moment. */
export function videoView(origin: string, digest: string, asset: Extract<Asset, { kind: 'video' }>, atMs?: number): VideoView {
  const { meta } = asset;
  return {
    ...(asset.source ? { src: sourceUrl(origin, digest) } : {}),
    poster: representationUrl(origin, digest, meta.poster),
    durationMs: meta.durationMs,
    size: { width: meta.width, height: meta.height },
    frames: meta.frames.map((f) => ({ src: representationUrl(origin, digest, f.frame), tMs: f.tMs })),
    ...(asset.transcript ? { transcript: asset.transcript.segments } : {}),
    ...(atMs !== undefined ? { atMs } : {}),
  };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * A moment in a video as people read one: `m:ss`, `h:mm:ss` past an hour, and
 * the fraction of a second when it has one (`0:00.25`), so nearby moments read apart.
 */
export function momentClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const fraction = ms % 1000 ? `.${String(ms % 1000).padStart(3, '0').replace(/0+$/, '')}` : '';
  return `${h > 0 ? `${h}:${pad2(m)}` : m}:${pad2(s % 60)}${fraction}`;
}

/** The WebVTT text of each track a player reads; a track with nothing to say is absent. */
export interface VideoTracks {
  thumbnails: string;
  captions?: string;
  chapters?: string;
}

interface Cue { startMs: number; endMs: number; text: string }

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
const timestamp = (ms: number): string =>
  `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
/** Cue text cannot hold `-->`, `&` and `<` begin markup, and a blank line ends the cue: one line, escaped. */
const escape = (text: string): string =>
  text.replace(/\s*[\r\n]+\s*/g, ' ').trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const webvtt = (cues: readonly Cue[]): string =>
  ['WEBVTT', '', ...cues.flatMap((c) => [`${timestamp(c.startMs)} --> ${timestamp(c.endMs)}`, c.text, ''])].join('\n');

/**
 * The tracks for a video: thumbnails always, captions when it was transcribed,
 * chapters when it opens at a moment. `base` is the page's address: a player
 * reads a thumbnail's address against the track's own, a `blob:` URL nothing
 * relative resolves against, so each frame is written whole.
 */
export function videoTracks(view: VideoView, base?: string): VideoTracks {
  const { frames, durationMs, size, transcript, atMs } = view;
  const fragment = size ? `#xywh=0,0,${size.width},${size.height}` : '';
  const whole = (src: string): string => (base ? new URL(src, base).href : src);
  // The first frame previews from the clip's start: a picture can begin after its sound.
  const thumbnails = frames.map((f, i) => ({
    startMs: i === 0 ? 0 : f.tMs,
    endMs: frames[i + 1]?.tMs ?? Math.max(durationMs, f.tMs),
    text: `${whole(f.src)}${fragment}`,
  }));
  const cited = atMs !== undefined && atMs > 0 && atMs < durationMs;
  return {
    thumbnails: webvtt(thumbnails),
    ...(transcript?.length ? { captions: webvtt(transcript.map((t) => ({ ...t, text: escape(t.text) }))) } : {}),
    ...(cited ? {
      chapters: webvtt([
        { startMs: 0, endMs: atMs, text: 'the clip' },
        { startMs: atMs, endMs: durationMs, text: 'cited in the report' },
      ]),
    } : {}),
  };
}
