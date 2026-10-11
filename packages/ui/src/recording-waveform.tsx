import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement, RefObject } from 'react';

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

/** Bars keep their pixel size at every width; a wider row shows more history, never fatter bars. */
const BAR = 2.5;
const PITCH = 6;
const HEIGHT = 28;
const QUIET = 3;
/** Below this a level is the room, drawn in the faint register so speech stands out from the floor. */
const FLOOR = 0.12;
const DEFAULT_WIDTH = 560;
/** The oldest history dissolves at the left edge instead of ending in a hard column. */
const fade = 'linear-gradient(to right, transparent, black 12%, black 100%)';

const clock = (seconds: number): string => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(node);
    setWidth(node.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Live microphone history; a quiet dotted baseline is the reduced-motion presentation. */
export function RecordingWaveform({ levels, elapsed, recording }: RecordingWaveformProps): ReactElement {
  const [track, width] = useWidth<HTMLDivElement>();
  const count = Math.max(1, Math.floor((width + (PITCH - BAR)) / PITCH));
  const recent = levels.slice(-count);
  const bars = [...Array<number>(count - recent.length).fill(0), ...recent];
  // Right-aligned so the newest level always sits at the right edge.
  const origin = width - count * PITCH + (PITCH - BAR);
  return <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: '1 1 auto', minWidth: 0, opacity: recording ? 1 : 0.45, transition: 'opacity .2s ease' }}>
    <style>{`.lloyal-wave-still { display: none; } @media (prefers-reduced-motion: reduce) { .lloyal-wave-live { display: none; } .lloyal-wave-still { display: block; } }`}</style>
    <div ref={track} style={{ flex: '1 1 auto', minWidth: 40, height: HEIGHT, maskImage: fade, WebkitMaskImage: fade }}>
      <svg aria-hidden="true" width="100%" height={HEIGHT} style={{ display: 'block' }}>
        <g className="lloyal-wave-live">{bars.map((level, index) => {
          const value = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
          const height = QUIET + value * (HEIGHT - QUIET - 3);
          const speech = value >= FLOOR;
          return <rect key={index} x={origin + index * PITCH} y={(HEIGHT - height) / 2} width={BAR} height={height} rx={BAR / 2} fill={speech ? ink : faint} opacity={speech ? 0.9 : value > 0 ? 0.5 : 0.35} />;
        })}</g>
        <g className="lloyal-wave-still">{bars.map((_, index) => <circle key={index} cx={origin + index * PITCH + BAR / 2} cy={HEIGHT / 2} r={BAR / 2} fill={faint} opacity="0.5" />)}</g>
      </svg>
    </div>
    {recording && <span style={{ font: `12px ${mono}`, color: muted, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>{clock(elapsed)}</span>}
  </div>;
}
