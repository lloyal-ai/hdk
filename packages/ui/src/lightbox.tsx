/**
 * The full-size view of one asset: a single image by its root, a PDF in the
 * browser's own viewer, or a video played from its original with the frames
 * the model saw beneath it. One enlarged view for a whole app — the figure
 * strip, a run bar's marker and a cited page in the prose all open this one,
 * so there is one that cannot drift. Escape and a click on the scrim close it.
 *
 * @category UI
 */
import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { representationUrl } from '@lloyal-labs/media';
import { useContentOrigin } from './provider.js';

const short = (digest: string): string => digest.replace(/^sha256:/, '').slice(0, 10);

export interface LightboxProps {
  /** The root of a single image to show — a photo, a page render. */
  digest?: string;
  /** Or a PDF to open in the browser's own viewer: the URL the content plane serves the original at. */
  pdf?: string;
  /** Or a video: its original to play (seekable — the content plane answers Range), the frames the
   *  model saw with their times, and what its soundtrack said. A frame seeks the player to its time. */
  video?: {
    src?: string;
    frames: { src: string; tMs: number }[];
    transcript?: { startMs: number; endMs: number; text: string }[];
    /** Where to start: a cited moment. */
    atMs?: number;
  };
  /** The representation's true pixel size, when the caller read it off the loaded element. */
  dims?: string;
  /** What is being shown, when it is not simply "the attached image". */
  label?: string;
  onClose: () => void;
  /** The caller's register: the scrim, the image and the caption. */
  styles?: { scrim?: CSSProperties; full?: CSSProperties; pdf?: CSSProperties; caption?: CSSProperties; strip?: CSSProperties; frame?: CSSProperties; seek?: CSSProperties };
}

const S: Required<NonNullable<LightboxProps['styles']>> = {
  scrim: {
    position: 'fixed', inset: 0, zIndex: 50, cursor: 'zoom-out', background: 'rgba(20,20,22,.82)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32,
  },
  full: { maxWidth: '100%', maxHeight: 'calc(100vh - 110px)', objectFit: 'contain', borderRadius: 12, background: '#fff' },
  pdf: { width: 'min(1100px, 94vw)', height: 'calc(100vh - 110px)', border: 0, borderRadius: 12, background: '#fff' },
  caption: { font: '12px system-ui, sans-serif', color: '#D8D8D2', margin: 0 },
  strip: { display: 'flex', gap: 6, overflowX: 'auto', maxWidth: 'min(1100px, 94vw)', padding: '2px 0' },
  frame: { height: 56, borderRadius: 6, flex: '0 0 auto', background: '#fff', display: 'block' },
  seek: { padding: 0, border: 0, background: 'none', borderRadius: 6, cursor: 'pointer', flex: '0 0 auto' },
};

const clock = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function Lightbox({ digest, pdf, video, dims, label, onClose, styles = {} }: LightboxProps): ReactElement | null {
  const origin = useContentOrigin();
  const player = useRef<HTMLVideoElement>(null);
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
    const said = (tMs: number): string | undefined => video.transcript?.find((t) => tMs >= t.startMs && tMs < t.endMs)?.text;
    return (
      <div style={s.scrim} role="dialog" aria-modal="true" aria-label={label ?? 'Attached video'} onClick={onClose}>
        {video.src !== undefined && (
          <>
            {/* CORS mode: the content plane answers every read with Access-Control-Allow-Origin. */}
            <video ref={player} src={video.src} controls crossOrigin="anonymous" style={s.full} onClick={(e) => e.stopPropagation()}
              onLoadedMetadata={(e) => { if (video.atMs !== undefined) e.currentTarget.currentTime = video.atMs / 1000; }} />
            <p style={s.caption}>{label ?? 'the attached video'} · the file as attached</p>
          </>
        )}
        <div style={s.strip} onClick={(e) => e.stopPropagation()}>
          {video.frames.map((f) => {
            const frame = <img src={f.src} alt={`frame at ${clock(f.tMs)}`} title={[clock(f.tMs), said(f.tMs)].filter(Boolean).join(' · ')} style={s.frame} />;
            // With the original kept, a frame is a control that plays from its moment; without one it is only a picture.
            return video.src === undefined
              ? <span key={f.tMs} style={{ flex: '0 0 auto' }}>{frame}</span>
              : <button key={f.tMs} type="button" style={s.seek} aria-label={`Play from ${clock(f.tMs)}`}
                  onClick={() => { if (player.current) player.current.currentTime = f.tMs / 1000; }}>{frame}</button>;
          })}
        </div>
        <p style={s.caption}>what the model saw · {video.frames.length} frame{video.frames.length === 1 ? '' : 's'}{video.transcript?.length ? ' and the transcript' : ''}</p>
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
