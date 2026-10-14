/**
 * The full-size view of one asset: a single image by its root, a PDF in the
 * browser's own viewer, or a video in {@link VideoPlayer}, the frames the model
 * saw on its time slider. One enlarged view for a whole app — the figure
 * strip, a run bar's marker and a cited page in the prose all open this one,
 * so there is one that cannot drift. Escape and a click on the scrim close it.
 *
 * @category UI
 */
import { Component, lazy, Suspense, useEffect } from 'react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { representationUrl } from '@lloyal-labs/media';
import { useContentOrigin } from './provider.js';
import type { VideoView } from './video-view.js';

/** Loaded when a video is first opened, so a page that never plays one carries none of Video.js. */
const VideoPlayer = lazy(() => import('./video-player.js').then((m) => ({ default: m.VideoPlayer })));

/** Whatever the player throws stays in the lightbox: the fallback plays the same file, and the page stands. */
class PlayerBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  override render(): ReactNode { return this.state.failed ? this.props.fallback : this.props.children; }
}

const short = (digest: string): string => digest.replace(/^sha256:/, '').slice(0, 10);

export interface LightboxProps {
  /** The root of a single image to show — a photo, a page render. */
  digest?: string;
  /** Or a PDF to open in the browser's own viewer: the URL the content plane serves the original at. */
  pdf?: string;
  /** Or a video ({@link videoView}): played from its original, opened at `atMs` when it was cited.
   *  Without an original there is nothing to play, and the frames the model saw are shown. */
  video?: VideoView;
  /** The representation's true pixel size, when the caller read it off the loaded element. */
  dims?: string;
  /** What is being shown, when it is not simply "the attached image". */
  label?: string;
  onClose: () => void;
  /** The caller's register: the scrim, the image and the caption. */
  styles?: { scrim?: CSSProperties; full?: CSSProperties; pdf?: CSSProperties; caption?: CSSProperties; player?: CSSProperties; frames?: CSSProperties; frame?: CSSProperties };
}

const S: Required<NonNullable<LightboxProps['styles']>> = {
  scrim: {
    position: 'fixed', inset: 0, zIndex: 50, cursor: 'zoom-out', background: 'rgba(20,20,22,.82)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32,
  },
  full: { maxWidth: '100%', maxHeight: 'calc(100vh - 110px)', objectFit: 'contain', borderRadius: 12, background: '#fff' },
  pdf: { width: 'min(1100px, 94vw)', height: 'calc(100vh - 110px)', border: 0, borderRadius: 12, background: '#fff' },
  caption: { font: '12px var(--harness-font, system-ui, sans-serif)', color: '#D8D8D2', margin: 0 },
  player: { width: 'min(1100px, 94vw)', maxHeight: 'calc(100vh - 110px)', aspectRatio: '16 / 9' },
  frames: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8,
    width: 'min(1100px, 94vw)', maxHeight: 'calc(100vh - 110px)', overflowY: 'auto',
  },
  frame: { width: '100%', borderRadius: 8, display: 'block', background: '#111' },
};

const clock = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function Lightbox({ digest, pdf, video, dims, label, onClose, styles = {} }: LightboxProps): ReactElement | null {
  const origin = useContentOrigin();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (origin === null) return null;
  const s = { ...S, ...styles };
  if (pdf !== undefined) {
    return (
      <div style={s.scrim} role="dialog" aria-modal="true" aria-label={label ?? 'Attached document'} onClick={onClose}>
        <iframe src={pdf} title={label ?? 'Attached document'} style={s.pdf} onClick={(e) => e.stopPropagation()} />
        <p style={s.caption}>{label ?? 'the attached document'} · the file as attached</p>
      </div>
    );
  }
  if (video !== undefined) {
    const { src } = video;
    const seen = `what the model saw · ${video.frames.length} frame${video.frames.length === 1 ? '' : 's'}${video.transcript?.length ? ', and the transcript as captions' : ''}`;
    const from = video.atMs !== undefined ? ` · from ${clock(video.atMs)}` : '';
    return (
      <div style={s.scrim} role="dialog" aria-modal="true" aria-label={label ?? 'Attached video'} onClick={onClose}>
        <div style={src !== undefined ? s.player : s.frames} onClick={(e) => e.stopPropagation()}>
          {src !== undefined
            ? (
                <PlayerBoundary fallback={
                  <video src={src} controls crossOrigin="anonymous" style={s.full} poster={video.poster}
                    onLoadedMetadata={(e) => { if (video.atMs !== undefined) e.currentTarget.currentTime = video.atMs / 1000; }} />
                }>
                  <Suspense fallback={video.poster ? <img src={video.poster} alt="" style={s.full} /> : null}>
                    <VideoPlayer video={{ ...video, src }} title={`${label ?? 'the attached video'}${from}`} />
                  </Suspense>
                </PlayerBoundary>
              )
            : video.frames.map((f) => (
                <figure key={f.tMs} style={{ margin: 0 }}>
                  <img src={f.src} alt={`frame at ${clock(f.tMs)}`} style={s.frame} />
                  <figcaption style={s.caption}>{clock(f.tMs)}</figcaption>
                </figure>
              ))}
        </div>
        <p style={s.caption}>{label ?? 'the attached video'}{from} · {src !== undefined ? 'hover the timeline for ' : ''}{seen}</p>
      </div>
    );
  }
  if (digest === undefined) return null;
  return (
    <div style={s.scrim} role="dialog" aria-modal="true" aria-label={label ?? 'Attached image, full size'} onClick={onClose}>
      <img src={representationUrl(origin, digest)} alt={label ?? 'Attached image, as the model received it'} style={s.full} />
      <p style={s.caption}>
        {label ?? 'what the model saw'}{dims ? ` · ${dims}` : ''} · {short(digest)}
      </p>
    </div>
  );
}
