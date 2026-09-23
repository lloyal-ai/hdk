/**
 * What a harness shows while it acquires what it needs to run.
 *
 * INSTALL IS NOT BOOT. This is for the run that must fetch weights — minutes,
 * once — and never for the run that merely loads weights already on disk, which
 * is every other run and takes seconds. A step list with a progress bar is
 * honest about the first and pure ceremony about the second, so a harness that
 * acquires nothing shows nothing and simply opens.
 *
 * Two things it does that a familiar installer does not. The bar measures the
 * ACTIVE STEP's bytes rather than how far through the list we are, because a
 * step-count bar barely moves through the one step that takes all the time. And
 * the figures you wait on — transferred, rate, time left — are in the open
 * rather than behind a details disclosure; a percentage alone cannot tell slow
 * from stalled, which is the actual worry.
 *
 * Every number shown is measured. A step that has not run says nothing, because
 * nothing is known about it yet.
 *
 * @category UI
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';

/**
 * One step, as a view needs it.
 *
 * Declared here rather than imported: `ui` depends on no engine package, so it
 * names the shape it renders and an engine's own step type satisfies it
 * structurally.
 */
export interface InstallerStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  /** Bytes so far and expected, while a download runs. */
  got?: number;
  total?: number;
  /** What this step found — a verdict, a name. Absent when there is nothing
   *  true to say, which is most steps most of the time. */
  note?: string;
}

export interface InstallerProps {
  /** Every step, in order, pending ones included — that is what lets a reader
   *  see where this is going rather than only where it is. */
  steps: readonly InstallerStep[];
  /** One quiet line under the header. The thing worth saying is usually that
   *  this happens once. */
  footnote?: string;
  /** Offered beside a failure, when there is something to retry. */
  onRetry?: () => void;
  /**
   * Use a file already on this machine instead of downloading one, for the step
   * whose id is given. Offered only where a placement can choose a file at all —
   * `useChooseFile()` is null in a browser — and only while that step is still
   * running, since afterwards there is nothing left to avoid.
   *
   * What happens to the chosen path is the caller's: it is a configured model
   * path, and changing one is a reload. This component neither knows nor asks.
   */
  onUseLocalFile?: (stepId: string) => void;
  /** Which steps may be satisfied by a local file. Default: the model. */
  localFileSteps?: readonly string[];
  /** The caller's register. */
  styles?: {
    /** NOTE: a slot REPLACES the default wholesale (`{ ...S, ...styles }`), the
     *  same contract as `Lightbox`. So a caller restyling `root` or `list`
     *  carries their layout properties too — the column and the list's
     *  `flexGrow` are what let the step list fill and anything after it sit low. */
    root?: CSSProperties; header?: CSSProperties; title?: CSSProperties; counter?: CSSProperties;
    track?: CSSProperties; bar?: CSSProperties; figures?: CSSProperties; footnote?: CSSProperties;
    list?: CSSProperties; row?: CSSProperties; rowActive?: CSSProperties; label?: CSSProperties;
    note?: CSSProperties; failure?: CSSProperties; footer?: CSSProperties; button?: CSSProperties;
    link?: CSSProperties;
  };
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const SANS = 'system-ui, sans-serif';

const S: Required<NonNullable<InstallerProps['styles']>> = {
  root: { boxSizing: 'border-box', width: '100%', display: 'flex', flexDirection: 'column', background: '#fff', color: '#17171B', fontFamily: SANS },
  header: { padding: '26px 30px 22px', display: 'flex', flexDirection: 'column', gap: 14 },
  title: { display: 'flex', alignItems: 'center', gap: 11, fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em' },
  counter: { fontFamily: MONO, fontSize: 12, color: '#9A9AA1', letterSpacing: '0.02em' },
  track: { height: 5, background: '#E9E9F2', borderRadius: 999, overflow: 'hidden' },
  bar: { height: '100%', background: '#3A56D4', borderRadius: 999, transition: 'width .25s linear' },
  figures: { display: 'flex', alignItems: 'center', gap: 8, fontFamily: MONO, fontSize: 12, color: '#78787F' },
  footnote: { marginLeft: 'auto', fontFamily: MONO, fontSize: 12, color: '#78787F' },
  list: { flexGrow: 1, padding: '14px 22px', display: 'flex', flexDirection: 'column', borderTop: '1px solid #EDEDF0' },
  row: { display: 'flex', alignItems: 'center', gap: 13, padding: '13px 10px' },
  rowActive: { background: '#FBFBFE', borderRadius: 8 },
  label: { flexGrow: 1, fontSize: 14.5 },
  note: { fontFamily: MONO, fontSize: 12, color: '#78787F' },
  failure: { margin: '4px 30px 0', padding: '16px 18px', background: '#FEF8F5', border: '1px solid #F3DFD4', borderRadius: 10, fontSize: 13.5, lineHeight: 1.55, color: '#3A3A42', whiteSpace: 'pre-line' },
  footer: { borderTop: '1px solid #EDEDF0', padding: '15px 30px', display: 'flex', alignItems: 'center', gap: 10 },
  button: { background: '#17171B', border: '1px solid #17171B', borderRadius: 7, padding: '8px 15px', cursor: 'pointer', fontFamily: SANS, fontSize: 13, fontWeight: 500, color: '#fff' },
  link: { background: 'none', border: 0, padding: 0, margin: 0, cursor: 'pointer', fontFamily: SANS, fontSize: 12.5, color: '#3A56D4', textDecoration: 'underline', textUnderlineOffset: 2 },
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

/**
 * Bytes per second, from what actually arrived.
 *
 * The engine reports position, never speed: rate is wall-clock, and the clock
 * that matters is the one in front of the reader. Averaged over a short window
 * so the figure is readable rather than twitching every tick.
 */
function useRate(got: number | undefined): number | null {
  const samples = useRef<{ at: number; got: number }[]>([]);
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    if (got === undefined) return;
    const now = Date.now();
    const s = samples.current;
    s.push({ at: now, got });
    while (s.length > 2 && now - s[0].at > 6000) s.shift();
    const first = s[0];
    const seconds = (now - first.at) / 1000;
    setRate(seconds >= 1 && got > first.got ? (got - first.got) / seconds : null);
  }, [got]);
  return rate;
}

function Marker({ status, accent }: { status: InstallerStep['status']; accent: string }): ReactElement {
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
        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="#C2410C" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === 'running') {
    // SMIL rather than a keyframe: this package ships no stylesheet, and only
    // the step actually running should move.
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
        <circle cx="8" cy="8" r="6.2" stroke="#E2E2EC" strokeWidth="1.8" />
        <path d="M8 1.8A6.2 6.2 0 0 1 14.2 8" stroke={accent} strokeWidth="1.8" strokeLinecap="round">
          <animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.9s" repeatCount="indefinite" />
        </path>
      </svg>
    );
  }
  return (
    <span style={{ width: 15, display: 'flex', justifyContent: 'center', flexShrink: 0 }} aria-hidden="true">
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#D4D4DC' }} />
    </span>
  );
}

export function Installer({
  steps, footnote, onRetry, onUseLocalFile, localFileSteps = ['model'], styles = {},
}: InstallerProps): ReactElement | null {
  const s = { ...S, ...styles };
  const active = steps.find((x) => x.status === 'running');
  const failed = steps.find((x) => x.status === 'failed');
  const head = failed ?? active;
  const rate = useRate(active?.got);
  if (steps.length === 0) return null;

  const accent = String(s.bar.background ?? S.bar.background);
  const position = head ? steps.indexOf(head) + 1 : steps.filter((x) => x.status === 'done').length;
  const pct = active && active.total ? Math.min(100, (active.got ?? 0) / active.total * 100) : failed ? 100 : 0;
  const left = active && active.total && rate ? duration((active.total - (active.got ?? 0)) / rate) : '';

  return (
    <section style={s.root} aria-label="Getting this harness ready">
      <div style={s.header}>
        <div style={s.title}>
          <Marker status={failed ? 'failed' : 'running'} accent={accent} />
          <span style={{ flexGrow: 1 }}>{head?.label ?? 'Getting ready'}</span>
          <span style={s.counter}>
            {failed ? `STOPPED AT STEP ${position}` : `STEP ${position} OF ${steps.length}`}
          </span>
        </div>

        <div style={s.track}>
          <div style={{ ...s.bar, width: `${pct}%`, ...(failed ? { background: '#C2410C' } : null) }} />
        </div>

        {/* Measured only: position, speed, and the time those two imply. */}
        <div style={s.figures} role="status" aria-live="polite">
          {active?.total ? <span style={{ color: '#17171B' }}>{bytes(active.got ?? 0)} / {bytes(active.total)}</span> : null}
          {rate ? <><span aria-hidden="true">·</span><span>{bytes(rate)}/s</span></> : null}
          {left ? <><span aria-hidden="true">·</span><span>{left}</span></> : null}
          {footnote ? <span style={s.footnote}>{footnote}</span> : null}
        </div>
      </div>

      <ol style={{ ...s.list, listStyle: 'none', margin: 0 }}>
        {steps.map((step) => (
          <li key={step.id} style={{ ...s.row, ...(step === head ? s.rowActive : null) }}>
            <Marker status={step.status} accent={accent} />
            <span style={{ ...s.label, ...(step.status === 'pending' ? { color: '#9A9AA1' } : null) }}>
              {step.label}
            </span>
            {/* A download already under way is the only moment this saves
                anything, so it is offered there and nowhere else. */}
            {onUseLocalFile && step.status === 'running' && localFileSteps.includes(step.id) ? (
              <button type="button" style={s.link} onClick={() => onUseLocalFile(step.id)}>
                Use a file I already have
              </button>
            ) : null}
            {step.note ? <span style={s.note}>{step.note}</span> : null}
          </li>
        ))}
      </ol>

      {failed?.note ? <p style={s.failure}>{failed.note}</p> : null}

      {failed && onRetry ? (
        <div style={s.footer}>
          <span style={{ flexGrow: 1 }} />
          <button type="button" style={s.button} onClick={onRetry}>Try again</button>
        </div>
      ) : null}
    </section>
  );
}
