/**
 * A video, played the way people expect a shared video to play: Video.js's
 * own skin, with what the model saw on its time slider. Hovering or dragging
 * the slider shows the frame the model was given there, the transcript plays
 * as captions, and a cited moment opens at its time with the slider broken
 * into a chapter that starts there.
 *
 * Themed like the rest of this package: the skin's colours, font and border
 * come from the `--harness-*` register where a harness sets it. Its layout
 * rules are a stylesheet, `@lloyal-labs/ui/video.css`, which an app imports
 * once in its page entry; this module imports no CSS, so it loads anywhere.
 *
 * @category UI
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement, RefObject } from 'react';
import { Video, VideoPlayer as Player, VideoSkin } from '@videojs/react/video';
import { videoTracks } from './video-view.js';
import type { VideoView } from './video-view.js';

/** The skin's custom properties, read from the harness register. */
const THEME = {
  '--media-accent-color': 'var(--harness-accent, #DD6B4A)',
  '--media-accent-text-color': 'var(--harness-bg, #FFFFFF)',
  '--media-border-color': 'var(--harness-rule, transparent)',
  '--media-border-radius': '12px',
  '--media-font-family': 'var(--harness-font, system-ui, sans-serif)',
} as CSSProperties;

type TrackUrls = { thumbnails: string; captions?: string; chapters?: string };

/**
 * Each track's WebVTT as a `blob:` URL (a page's CSP admits `blob:` media).
 * Made by the effect that lets them go, so every setup revokes only its own:
 * under StrictMode, which sets effects up, tears them down and sets them up
 * again, the tracks point at the second setup's live files. Null until then.
 */
function useTrackUrls(view: VideoView): TrackUrls | null {
  const [urls, setUrls] = useState<TrackUrls | null>(null);
  useEffect(() => {
    const url = (vtt: string): string => URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
    const tracks = videoTracks(view, document.baseURI);
    const made: TrackUrls = {
      thumbnails: url(tracks.thumbnails),
      ...(tracks.captions ? { captions: url(tracks.captions) } : {}),
      ...(tracks.chapters ? { chapters: url(tracks.chapters) } : {}),
    };
    setUrls(made);
    return () => Object.values(made).forEach((u) => URL.revokeObjectURL(u));
  }, [view]);
  return urls;
}

export interface VideoPlayerProps {
  /** The video to play; it needs its original (`src`). */
  video: VideoView & { src: string };
  /** What the player's title reads. */
  title?: string;
  /** Layout and any of the skin's `--media-*` properties, over the harness register. */
  style?: CSSProperties;
  className?: string;
}

/** Open at `atMs`: at once when the media already knows its length, else when it learns it. */
function useStartAt(media: RefObject<HTMLVideoElement | null>, atMs: number | undefined, src: string): void {
  useEffect(() => {
    const element = media.current;
    if (!element || atMs === undefined) return;
    const seek = (): void => { element.currentTime = atMs / 1000; };
    if (element.readyState >= HTMLMediaElement.HAVE_METADATA) seek();
    else element.addEventListener('loadedmetadata', seek, { once: true });
    return () => element.removeEventListener('loadedmetadata', seek);
  }, [media, atMs, src]);
}

/**
 * Chromium fails a whole playback with AUDIO_RENDERER_ERROR when it cannot open
 * the audio output (on macOS, around an output device change), and its pipeline
 * stays dead. Reloading at the same moment reopens the device and plays on; a
 * second failure in a row goes on muted, so the picture is never lost to sound.
 */
function useRecoverAudioOutput(media: RefObject<HTMLVideoElement | null>): void {
  useEffect(() => {
    const element = media.current;
    if (!element) return;
    let failures = 0;
    const onError = (): void => {
      if (!/AUDIO_RENDERER/.test(element.error?.message ?? '')) return;
      failures += 1;
      const at = element.currentTime;
      element.addEventListener('loadedmetadata', () => {
        element.currentTime = at;
        if (failures > 1) element.muted = true;
        element.play().catch(() => {});
      }, { once: true });
      element.load();
    };
    const onPlaying = (): void => { failures = 0; };
    element.addEventListener('error', onError);
    element.addEventListener('playing', onPlaying);
    return () => {
      element.removeEventListener('error', onError);
      element.removeEventListener('playing', onPlaying);
    };
  }, [media]);
}

export function VideoPlayer({ video, title, style, className }: VideoPlayerProps): ReactElement {
  const tracks = useTrackUrls(video);
  const media = useRef<HTMLVideoElement>(null);
  useStartAt(media, video.atMs, video.src);
  useRecoverAudioOutput(media);
  return (
    <Player title={title} poster={video.poster}>
      <VideoSkin style={{ ...THEME, ...style }} {...(className ? { className } : {})}>
        {/* CORS mode: the content plane answers every read with Access-Control-Allow-Origin. */}
        <Video ref={media} src={video.src} crossOrigin="anonymous" playsInline>
          {tracks && <track kind="metadata" label="thumbnails" src={tracks.thumbnails} default />}
          {tracks?.captions && <track kind="captions" label="Transcript" srcLang="und" src={tracks.captions} default />}
          {tracks?.chapters && <track kind="chapters" label="Chapters" srcLang="und" src={tracks.chapters} default />}
        </Video>
      </VideoSkin>
    </Player>
  );
}

