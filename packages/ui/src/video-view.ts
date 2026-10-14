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
/** Cue text cannot hold `-->`, and `&` and `<` begin markup. */
const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const webvtt = (cues: readonly Cue[]): string =>
  ['WEBVTT', '', ...cues.flatMap((c) => [`${timestamp(c.startMs)} --> ${timestamp(c.endMs)}`, c.text, ''])].join('\n');

/** The tracks for a video: thumbnails always, captions when it was transcribed, chapters when it opens at a moment. */
export function videoTracks(view: VideoView): VideoTracks {
  const { frames, durationMs, size, transcript, atMs } = view;
  const fragment = size ? `#xywh=0,0,${size.width},${size.height}` : '';
  const thumbnails = frames.map((f, i) => ({
    startMs: f.tMs,
    endMs: frames[i + 1]?.tMs ?? Math.max(durationMs, f.tMs),
    text: `${f.src}${fragment}`,
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
