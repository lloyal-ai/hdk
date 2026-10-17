/**
 * A video on the canvas, the way a shared video is shown: its poster, a play
 * mark and its length. Its own module, apart from the player, so a page that
 * shows cards loads nothing of Video.js until one is opened.
 *
 * @category UI
 */
import type { CSSProperties, ReactElement } from 'react';
import type { VideoView } from './video-view.js';

const clock = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  return `${h > 0 ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`;
};

const CARD: Record<'card' | 'poster' | 'play' | 'duration', CSSProperties> = {
  card: {
    position: 'relative', display: 'block', padding: 0, border: '1px solid var(--harness-rule, transparent)', cursor: 'pointer',
    width: 220, aspectRatio: '16 / 9', overflow: 'hidden', borderRadius: 10, background: '#111',
  },
  poster: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  play: {
    position: 'absolute', inset: 0, margin: 'auto', width: 44, height: 44, borderRadius: '50%',
    background: 'rgba(0,0,0,.55)', display: 'grid', placeItems: 'center',
  },
  duration: {
    position: 'absolute', right: 6, bottom: 6, padding: '1px 5px', borderRadius: 4, background: 'rgba(0,0,0,.75)', color: '#fff',
    font: '500 11px var(--harness-mono, ui-monospace, SFMono-Regular, Menlo, monospace)', fontVariantNumeric: 'tabular-nums',
  },
};

export interface VideoCardProps {
  video: VideoView;
  /** What a screen reader hears; the visible card says it with its play mark. */
  label?: string;
  onOpen: () => void;
  /** The card's own look, over the harness register. */
  styles?: Partial<typeof CARD>;
}

/** A video on the canvas: its poster with a play mark and its length, the way a shared video is shown. */
export function VideoCard({ video, label, onOpen, styles = {} }: VideoCardProps): ReactElement {
  const s = { ...CARD, ...styles };
  const playable = video.src !== undefined;
  return (
    <button type="button" style={s.card} onClick={onOpen}
      aria-label={label ?? (playable ? `Play the attached video, ${clock(video.durationMs)}` : 'Show the frames of the attached video')}>
      {video.poster && <img src={video.poster} alt="" style={s.poster} />}
      <span style={s.play} aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z" /></svg>
      </span>
      <span style={s.duration} aria-hidden="true">{clock(video.durationMs)}</span>
    </button>
  );
}
