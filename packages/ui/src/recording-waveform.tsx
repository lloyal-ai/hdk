import type { ReactElement } from 'react';

export interface RecordingWaveformProps {
  /** Normalized input levels, oldest first; the newest draws at the right edge. */
  levels: readonly number[];
  elapsed: number;
  /** While recording the bars move and the clock runs; afterwards the last shape stays, dimmed, until the transcript lands. */
  recording: boolean;
}

/** Drawn with the harness register where it is set, and with the composer's own color where it is not. */
const ink = 'var(--harness-fg, currentColor)';
const faint = 'var(--harness-faint, currentColor)';
const muted = 'var(--harness-muted, currentColor)';
const mono = 'var(--harness-mono, ui-monospace, SFMono-Regular, Menlo, monospace)';

const BARS = 80;
const clock = (seconds: number): string => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

/** Live microphone history; a quiet dotted baseline is the reduced-motion presentation. */
export function RecordingWaveform({ levels, elapsed, recording }: RecordingWaveformProps): ReactElement {
  const recent = levels.slice(-BARS);
  const bars = [...Array<number>(BARS - recent.length).fill(0), ...recent];
  return <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: '1 1 auto', minWidth: 0, opacity: recording ? 1 : 0.45, transition: 'opacity .2s ease' }}>
    <style>{`.lloyal-wave-still { display: none; } @media (prefers-reduced-motion: reduce) { .lloyal-wave-live { display: none; } .lloyal-wave-still { display: block; } }`}</style>
    <svg aria-hidden="true" viewBox="0 0 560 28" preserveAspectRatio="none" style={{ height: 28, flex: '1 1 auto', minWidth: 40 }}>
      <g className="lloyal-wave-live">{bars.map((level, index) => {
        const value = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
        const height = 3 + value * 22;
        return <rect key={index} x={index * 7} y={(28 - height) / 2} width="3" height={height} rx="1.5" fill={value > 0 ? ink : faint} opacity={value > 0 ? 0.9 : 0.35} />;
      })}</g>
      <g className="lloyal-wave-still">{bars.map((_, index) => <circle key={index} cx={index * 7 + 1.5} cy="14" r="1.5" fill={faint} opacity="0.5" />)}</g>
    </svg>
    {recording && <span style={{ font: `12px ${mono}`, color: muted, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>{clock(elapsed)}</span>}
  </div>;
}
