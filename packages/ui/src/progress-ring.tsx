/**
 * Progress as a ring, the way a messaging app shows an upload: it fills as
 * work advances with the percentage in its middle, and spins where the work has
 * no count to fill by. Drawn in the harness register's accent over its rule
 * colour; the percentage takes the surrounding text colour.
 *
 * @category UI
 */
import type { ReactElement } from 'react';

const accent = 'var(--harness-accent, #DD6B4A)';
const track = 'var(--harness-rule, rgba(255,255,255,.25))';

export interface ProgressRingProps {
  /** How far along, in [0, 1]; null when there is no count, and the ring spins. */
  fraction: number | null;
  /** What a screen reader hears: the work and how far it is. */
  label: string;
  /** The ring's diameter in pixels. */
  size?: number;
}

export function ProgressRing({ fraction, label, size = 44 }: ProgressRingProps): ReactElement {
  const stroke = Math.max(2, Math.round(size / 12));
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const shown = fraction === null ? 0.25 : Math.min(1, Math.max(0, fraction));
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(fraction === null ? {} : { 'aria-valuenow': Math.round(shown * 100) })}
      style={{ position: 'relative', display: 'inline-block', width: size, height: size, lineHeight: 0 }}
    >
      <style>{'@keyframes lloyal-ring { to { transform: rotate(360deg); } } .lloyal-ring-spin { animation: lloyal-ring 1s linear infinite; transform-origin: center; } @media (prefers-reduced-motion: reduce) { .lloyal-ring-spin { animation-duration: 3s; } }'}</style>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <g className={fraction === null ? 'lloyal-ring-spin' : undefined}>
          <circle
            cx={size / 2} cy={size / 2} r={r} fill="none" stroke={accent} strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={`${circumference * shown} ${circumference}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            style={{ transition: 'stroke-dasharray .25s ease' }}
          />
        </g>
      </svg>
      {fraction !== null && (
        <span aria-hidden="true" style={{
          position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', lineHeight: 1,
          font: `600 ${Math.round(size / 3.6)}px var(--harness-font, system-ui, sans-serif)`, fontVariantNumeric: 'tabular-nums',
        }}>{Math.round(shown * 100)}%</span>
      )}
    </span>
  );
}
