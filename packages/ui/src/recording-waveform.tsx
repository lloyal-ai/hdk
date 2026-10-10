import type { CSSProperties, ReactElement } from 'react';

export interface RecordingWaveformProps {
  /** Normalized input levels, oldest first. */
  levels: readonly number[];
  elapsed: number;
  recording: boolean;
  status?: string;
}

const BARS = 80;
const clock = (seconds: number): string => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

/** Live microphone history; the quiet baseline is also the reduced-motion presentation. */
export function RecordingWaveform({ levels, elapsed, recording, status }: RecordingWaveformProps): ReactElement {
  const recent = levels.slice(-BARS);
  const bars = [...Array<number>(BARS - recent.length).fill(0), ...recent];
  return <div style={strip}>
    <style>{`.lloyal-wave-still { display: none; } @media (prefers-reduced-motion: reduce) { .lloyal-wave-live { display: none; } .lloyal-wave-still { display: block; } }`}</style>
    <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: recording ? '#ff453a' : 'currentColor', opacity: recording ? 1 : 0.4, flex: '0 0 auto' }} />
    <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: '5ch' }}>{clock(elapsed)}</span>
    <svg aria-hidden="true" viewBox="0 0 560 36" preserveAspectRatio="none" style={{ height: 36, flex: '1 1 auto', minWidth: 40, maxWidth: 680 }}>
      <g className="lloyal-wave-live">{bars.map((level, index) => {
        const value = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
        const height = 4 + value * 24;
        return <rect key={index} x={index * 7} y={(36 - height) / 2} width="4" height={height} rx="2" fill="var(--lloyal-voice-blue, #0a84ff)" opacity={value > 0 ? 0.9 : 0.35} />;
      })}</g>
      <g className="lloyal-wave-still">{bars.map((_, index) => <circle key={index} cx={index * 7 + 2} cy="18" r="2" fill="var(--lloyal-voice-blue, #0a84ff)" opacity="0.4" />)}</g>
    </svg>
    <span role="status" style={{ marginLeft: 'auto', fontSize: 12, whiteSpace: 'nowrap' }}>{status ?? (recording ? 'Recording' : 'Click to speak')}</span>
  </div>;
}

const strip: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, borderTop: '1px solid var(--lloyal-voice-border, rgba(128,128,128,.18))',
  padding: '10px 0 0', color: 'var(--lloyal-voice-muted, #8e8e93)', fontSize: 12,
};
