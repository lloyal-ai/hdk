/**
 * What a harness shows while it acquires what it needs to run.
 *
 * INSTALL IS NOT BOOT. This is for the run that must fetch weights — minutes, once — and never
 * for the run that merely loads weights already on disk, which is every other run and takes
 * seconds. A step list with a progress bar is honest about the first and pure ceremony about
 * the second, so a harness that acquires nothing shows nothing and simply opens.
 *
 * Two things it does that a familiar installer does not. The bar measures the ACTIVE STEP's
 * bytes rather than how far through the list we are, because a step-count bar barely moves
 * through the one step that takes all the time. And the figures you wait on — transferred,
 * rate, time left — are in the open rather than behind a details disclosure; a percentage
 * alone cannot tell slow from stalled, which is the actual worry.
 *
 * Every number shown is measured. A step that has not run says nothing, because nothing is
 * known about it yet.
 *
 * It takes the harness's theme through CSS custom properties, each with the platform's own
 * value as its default: `--harness-accent`, `--harness-fg`, `--harness-bg` (the card), `--harness-ground`
 * (the page behind it), `--harness-muted`, `--harness-faint`, `--harness-rule`, `--harness-font`,
 * `--harness-mono`. A harness sets them on an ancestor of the provider — the document root, or the element the
 * provider mounts under — and passes nothing; the installer stands in for the view, so properties set inside
 * the view never reach it. It fills the window: the card sits
 * in a gutter on the ground, and the step list takes whatever height the header and footer leave.
 *
 * @category UI
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';

/**
 * One step, as a view needs it. Declared here rather than imported: `ui` depends on no engine
 * package, so it names the shape it renders and an engine's own step type satisfies it structurally.
 */
export interface InstallerStep {
  id: string;
  label: string;
  /** The model this step acquires, by name, and the slot it fills — the subtitle under the heading. */
  model?: string;
  slot?: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  /** Bytes so far and expected, while a download runs. */
  got?: number;
  total?: number;
  /** What this step found — a verdict, a name, why it failed. Absent when there is nothing true to say. */
  note?: string;
  /** Whether a file already on this machine may stand in for this step's download. */
  file?: boolean;
}

export interface InstallerProps {
  /** Every step, in order, pending ones included — that is what lets a reader see where this is going rather
   *  than only where it is. */
  steps: readonly InstallerStep[];
  /** One quiet line under the header. The thing worth saying is usually that this happens once. */
  footnote?: string;
  /** Run the failed step again. Offered beside a failure. */
  onRetry?: () => void;
  /** What the retry says — "Try again" unless the placement offers something else, such as a new engine. */
  retryLabel?: string;
  /** Use a file already on this machine for the step whose id is given. Offered only where the placement can
   *  choose a file at all, and only on a step that takes one — while it downloads, or after it failed. */
  onUseFile?: (stepId: string) => void;
  /** Stop the install, and the run with it. Offered beside a failure. */
  onStop?: () => void;
}

/** The theme, as the harness sets it, with the platform's values where it does not. */
const T = {
  accent: 'var(--harness-accent, #3A56D4)',
  fg: 'var(--harness-fg, #17171B)',
  bg: 'var(--harness-bg, #FFFFFF)',
  ground: 'var(--harness-ground, #F4F4F1)',
  muted: 'var(--harness-muted, #6B6B72)',
  faint: 'var(--harness-faint, #75757D)',
  rule: 'var(--harness-rule, #EDEDF0)',
  font: 'var(--harness-font, system-ui, sans-serif)',
  mono: 'var(--harness-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
  failure: '#C2410C',
};

const S: Record<string, CSSProperties> = {
  root: { boxSizing: 'border-box', width: '100%', minHeight: '100vh', padding: 20, display: 'flex', flexDirection: 'column', background: T.ground, color: T.fg, fontFamily: T.font },
  card: { flexGrow: 1, display: 'flex', flexDirection: 'column', background: T.bg, border: `1px solid ${T.rule}`, borderRadius: 12, overflow: 'hidden' },
  header: { padding: '26px 30px 22px', display: 'flex', flexDirection: 'column', gap: 14 },
  title: { display: 'flex', alignItems: 'center', gap: 11, fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em' },
  subtitle: { display: 'flex', alignItems: 'baseline', gap: 8, marginTop: -6, paddingLeft: 26, fontSize: 13, color: T.muted },
  slot: { fontFamily: T.mono, fontSize: 12, color: T.faint },
  counter: { fontFamily: T.mono, fontSize: 12, color: T.faint, letterSpacing: '0.02em' },
  track: { height: 5, background: T.rule, borderRadius: 999, overflow: 'hidden' },
  bar: { height: '100%', background: T.accent, borderRadius: 999, transition: 'width .25s linear' },
  figures: { display: 'flex', alignItems: 'center', gap: 8, fontFamily: T.mono, fontSize: 12, color: T.muted },
  footnote: { marginLeft: 'auto', fontFamily: T.mono, fontSize: 12, color: T.muted },
  list: { flexGrow: 1, padding: '14px 22px', display: 'flex', flexDirection: 'column', borderTop: `1px solid ${T.rule}`, listStyle: 'none', margin: 0 },
  row: { display: 'flex', alignItems: 'center', gap: 13, padding: '13px 10px' },
  rowActive: { background: 'color-mix(in srgb, currentColor 2%, transparent)', borderRadius: 8 },
  label: { flexGrow: 1, fontSize: 14.5 },
  note: { fontFamily: T.mono, fontSize: 12, color: T.muted },
  failure: { margin: '4px 30px 0', padding: '16px 18px', background: 'color-mix(in srgb, #C2410C 6%, transparent)', border: '1px solid color-mix(in srgb, #C2410C 20%, transparent)', borderRadius: 10, fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-line' },
  footer: { borderTop: `1px solid ${T.rule}`, padding: '15px 30px', display: 'flex', alignItems: 'center', gap: 10 },
  button: { background: T.fg, border: `1px solid ${T.fg}`, borderRadius: 7, padding: '8px 15px', cursor: 'pointer', fontFamily: T.font, fontSize: 13, fontWeight: 500, color: T.bg },
  // The file offer is a way out, not the way forward: quiet grey beside the row, never the accent that invites a click.
  link: { background: 'none', border: 0, padding: 0, margin: 0, cursor: 'pointer', fontFamily: T.font, fontSize: 12.5, color: T.faint },
  quiet: { background: 'none', border: 0, padding: '8px 8px 8px 0', margin: 0, cursor: 'pointer', fontFamily: T.font, fontSize: 13, color: T.muted },
};

const KB = 1024;
function bytes(n: number): string {
  if (n >= KB ** 3) return `${(n / KB ** 3).toFixed(2)} GB`;
  if (n >= KB ** 2) return `${(n / KB ** 2).toFixed(0)} MB`;
  return `${(n / KB).toFixed(0)} KB`;
}

/** Spoken, not computed-looking: a wait is read, not measured. */
function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `about ${Math.max(5, Math.round(seconds / 5) * 5)} s left`;
  const m = Math.floor(seconds / 60);
  const s = Math.round((seconds % 60) / 10) * 10;
  return s > 0 ? `about ${m} min ${s} s left` : `about ${m} min left`;
}

/** One reading of a step's position, and when it was taken. */
export interface Sample { at: number; got: number }

/** How long a sample counts for. A window with nothing newer than this is a stall, and a stall has no rate. */
const WINDOW_MS = 6000;

/** The rate ONE step's samples imply, read against the clock: bytes per second across the window, once a
 *  second has passed and bytes have moved; null before that, null for a step that has not moved, and null
 *  once nothing has arrived for the whole window — a stalled transfer shows no speed rather than its last. */
export function rateOf(samples: readonly Sample[], now: number): number | null {
  if (samples.length === 0) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (now - last.at > WINDOW_MS) return null;
  const seconds = (now - first.at) / 1000;
  return seconds >= 1 && last.got > first.got ? (last.got - first.got) / seconds : null;
}

/**
 * Bytes per second, from what actually arrived. The engine reports position, never speed: rate is
 * wall-clock, and the clock that matters is the one in front of the reader. Averaged over a short window
 * so the figure is readable rather than twitching every tick. Measured PER STEP: the window empties when the
 * active step changes, and a step with no position — finished, failed, not yet begun — has no rate. Read
 * once a second while a step has a position, not only when a byte arrives, so a transfer that stalls is seen
 * to stall: its figure falls, then goes.
 */
function useRate(step: string | undefined, got: number | undefined): number | null {
  const window = useRef<{ step: string | undefined; samples: Sample[] }>({ step: undefined, samples: [] });
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    const w = window.current;
    if (w.step !== step) { w.step = step; w.samples = []; }
    if (got === undefined) { setRate(null); return; }
    const now = Date.now();
    w.samples.push({ at: now, got });
    while (w.samples.length > 2 && now - w.samples[0].at > WINDOW_MS) w.samples.shift();
    setRate(rateOf(w.samples, now));
  }, [step, got]);
  useEffect(() => {
    if (got === undefined) return;
    const tick = setInterval(() => setRate(rateOf(window.current.samples, Date.now())), 1000);
    return () => clearInterval(tick);
  }, [step, got === undefined]);
  return rate;
}

function Marker({ status }: { status: InstallerStep['status'] }): ReactElement {
  if (status === 'done') {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
        <path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === 'failed') {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke={T.failure} strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === 'running') {
    // SMIL rather than a keyframe: this package ships no stylesheet, and only the step actually running should move.
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
        <circle cx="8" cy="8" r="6.2" stroke={T.rule} strokeWidth="1.8" />
        <path d="M8 1.8A6.2 6.2 0 0 1 14.2 8" stroke={T.accent} strokeWidth="1.8" strokeLinecap="round">
          <animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.9s" repeatCount="indefinite" />
        </path>
      </svg>
    );
  }
  return (
    <span style={{ width: 15, display: 'flex', justifyContent: 'center', flexShrink: 0 }} aria-hidden="true">
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: T.rule }} />
    </span>
  );
}

export function Installer({ steps, footnote, onRetry, retryLabel = 'Try again', onUseFile, onStop }: InstallerProps): ReactElement | null {
  const active = steps.find((x) => x.status === 'running');
  const failed = steps.find((x) => x.status === 'failed');
  const head = failed ?? active;
  const rate = useRate(active?.id, active?.got);
  if (steps.length === 0) return null;

  const position = head ? steps.indexOf(head) + 1 : steps.filter((x) => x.status === 'done').length;
  // The bar shows what was measured, for a failed step too: where it stopped, or nothing where nothing arrived.
  const shown = active ?? failed;
  const pct = shown && shown.total ? Math.min(100, ((shown.got ?? 0) / shown.total) * 100) : 0;
  const left = active && active.total && rate ? duration((active.total - (active.got ?? 0)) / rate) : '';
  const fileFor = (step: InstallerStep): boolean => !!onUseFile && !!step.file && (step.status === 'running' || step.status === 'failed');

  return (
    <section style={S.root} aria-label="Getting this harness ready">
      <div style={S.card}>
      <div style={S.header}>
        <div style={S.title}>
          <Marker status={failed ? 'failed' : 'running'} />
          <span style={{ flexGrow: 1 }}>{head?.label ?? 'Getting ready'}</span>
          <span style={S.counter}>{failed ? `STOPPED AT STEP ${position}` : `STEP ${position} OF ${steps.length}`}</span>
        </div>
        {/* What is arriving, and where it lands: the model's name and its slot, under the heading. */}
        {head?.model ? (
          <div style={S.subtitle}>
            <span>{head.model}</span>
            {head.slot ? <span style={S.slot}>{head.slot}</span> : null}
          </div>
        ) : null}
        <div style={S.track}>
          <div style={{ ...S.bar, width: `${pct}%`, ...(failed ? { background: T.failure } : null) }} />
        </div>
        {/* Measured only: position, speed, and the time those two imply. */}
        <div style={S.figures} role="status" aria-live="polite">
          {active?.total ? <span style={{ color: T.fg }}>{bytes(active.got ?? 0)} / {bytes(active.total)}</span> : null}
          {rate ? <><span aria-hidden="true">·</span><span>{bytes(rate)}/s</span></> : null}
          {left ? <><span aria-hidden="true">·</span><span>{left}</span></> : null}
          {footnote ? <span style={S.footnote}>{footnote}</span> : null}
        </div>
      </div>

      <ol style={S.list}>
        {steps.map((step) => (
          <li key={step.id} style={{ ...S.row, ...(step === head ? S.rowActive : null) }}>
            <Marker status={step.status} />
            <span style={{ ...S.label, ...(step.status === 'pending' ? { color: T.faint } : null) }}>{step.label}</span>
            {fileFor(step) ? (
              <button type="button" style={S.link} onClick={() => onUseFile!(step.id)}>Use a file I already have</button>
            ) : null}
            {step.note ? <span style={{ ...S.note, ...(step.status === 'failed' ? { color: T.failure } : null) }}>{step.note}</span> : null}
          </li>
        ))}
      </ol>

      {failed?.note ? <p style={S.failure}>{failed.note}</p> : null}

      {failed ? (
        <div style={S.footer}>
          {onStop ? <button type="button" style={S.quiet} onClick={onStop}>Stop</button> : null}
          <span style={{ flexGrow: 1 }} />
          {onRetry ? <button type="button" style={S.button} onClick={onRetry}>{retryLabel}</button> : null}
        </div>
      ) : null}
      </div>
    </section>
  );
}
