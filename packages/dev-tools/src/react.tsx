/**
 * The dev pane's web/desktop surface: a cog FAB that docks a full-width pane
 * over the harness's own view — Timeline · Sources · Settings.
 *
 * Mounted ONCE beside the app's view; it subscribes to the same bridge stream
 * through {@link createDevStore} (wire-gated: a production stream folds
 * nothing but `config:loaded`). Rendering is hand-rolled — no timeline
 * library: the design's invariants (fixed-span sliding window, stepped live
 * edge, wait stripes CUT into capsules, letter badges with a collision rule)
 * are cheaper to own than to fight a library for.
 *
 * Everything shown is a recorded event field; absence renders as absence.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useStore } from 'zustand';
import {
  pressureStrip, pressurePercent, readConfigPath, sparkOf, KEY_TIERS,
} from './index';
import type {
  AbilityInfo, AgentLane, DevControl, Intervention, PaneModel, PaneTab, Retrieval,
} from './index';
import { devStoreFor, EDGE_STEP } from './store';
import type { DevBridge, DevStore } from './store';

export type { DevBridge } from './store';

export interface DevPaneProps {
  bridge: DevBridge;
  /** Template-contributed Settings controls (research passes effort/mode
   *  rows; basic passes none — its Settings is the read-only inspector). */
  controls?: readonly DevControl[];
  /** Shown in the status area. */
  title?: string;
}

// ── palette: monochrome chrome, color reserved for data ──
const C = {
  text: '#202124', dim: '#5f6368', faint: '#9aa0a6', border: '#e8eaed',
  hair: '#f4f5f7', chromeBg: '#f1f3f4', panelBg: '#fafbfc',
  agent: '#1a73e8', agentDark: '#174ea6', fail: '#b3261e', ok: '#188038',
  warn: '#9a6700', warnBg: '#fef7e0', warnBorder: '#f9d67a',
};
const TOOL_PALETTE = ['#e8710a', '#8430ce', '#00897b', '#d01884', '#827717', '#0097a7'];
const mono = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** Per-tool color, assigned first-seen — stable within a run. */
function useToolColors(): (name: string) => string {
  const map = useRef(new Map<string, string>());
  return (name: string) => {
    if (!map.current.has(name)) {
      map.current.set(name, TOOL_PALETTE[map.current.size % TOOL_PALETTE.length]);
    }
    return map.current.get(name)!;
  };
}
const letterOf = (name: string): string => (name[0] || '?').toUpperCase();
const fmtS = (s: number): string =>
  s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${s.toFixed(1)}s`;

/** Live when any lane is still open. */
function isLive(m: PaneModel): boolean {
  for (const l of m.lanes.values()) if (l.doneAt === null) return true;
  return false;
}
function runEndS(m: PaneModel): number {
  let end = 0;
  for (const l of m.lanes.values()) {
    if (l.doneAt !== null) end = Math.max(end, l.doneAt);
  }
  return m.runStartAt === null ? 0 : Math.max(0, (end - m.runStartAt) / 1000);
}

// ═══════════════════════════════════════════════════════════════
export function DevPane({ bridge, controls = [], title }: DevPaneProps): ReactElement | null {
  // The store is a per-bridge SINGLETON: a remount reattaches to the running
  // fold (full history intact) instead of restarting it and desyncing. It is
  // deliberately NOT destroyed on unmount — it lives with the page, like the
  // bridge itself (dev-gated; a production stream folds nothing).
  const store = devStoreFor(bridge);

  const rev = useStore(store, (s) => s.rev);
  const m = store.getState().model;
  const [open, setOpen] = useState(false);

  // The FAB renders only when the wire said dev — production ships inert.
  if (!m.dev) return null;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label="open the dev pane"
        title="dev pane (LLOYAL_DEV)"
        style={{
          position: 'fixed', right: 20, bottom: 20, width: 44, height: 44,
          borderRadius: '50%', background: '#fff', border: `1px solid #dadce0`,
          display: 'grid', placeItems: 'center', color: C.dim, cursor: 'pointer',
          boxShadow: '0 2px 8px rgba(32,33,36,.14)', zIndex: 40, padding: 0,
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    );
  }

  return <Pane key={rev >= 0 ? 'pane' : 'pane'} store={store} m={m} rev={rev} controls={controls} title={title} onClose={() => setOpen(false)} />;
}

// ═══ the docked pane ═══
function Pane({ store, m, rev, controls, title, onClose }: {
  store: DevStore; m: PaneModel; rev: number;
  controls: readonly DevControl[]; title?: string; onClose: () => void;
}): ReactElement {
  const [tab, setTab] = useState<PaneTab>('timeline');
  const [selAgent, setSelAgent] = useState<number | null>(null);
  const toolColor = useToolColors();
  const paneRef = useRef<HTMLDivElement | null>(null);

  // The pane is fixed, so the document doesn't know it's there — reserve its
  // height as body padding while open, so the app's bottom content can always
  // scroll clear of it. Restored on close/unmount.
  useEffect(() => {
    const prev = document.body.style.paddingBottom;
    const apply = (): void => {
      if (paneRef.current) document.body.style.paddingBottom = `${paneRef.current.offsetHeight}px`;
    };
    apply();
    window.addEventListener('resize', apply);
    return () => {
      window.removeEventListener('resize', apply);
      document.body.style.paddingBottom = prev;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (selAgent !== null) setSelAgent(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selAgent, onClose]);

  const live = isLive(m);
  const lanes = [...m.lanes.values()];
  const done = lanes.filter((l) => l.doneAt !== null).length;
  const toolsSeen = [...new Set(m.retrievals.map((r) => r.tool))];

  const tabStyle = (on: boolean): React.CSSProperties => ({
    padding: '0 13px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
    color: on ? C.text : C.dim, borderRight: `1px solid ${C.border}`, cursor: 'pointer',
    background: on ? '#fff' : 'transparent', fontWeight: on ? 500 : 400,
    boxShadow: on ? `inset 0 2px 0 ${C.text}` : undefined,
  });

  return (
    <div ref={paneRef} style={{
      position: 'fixed', left: 0, right: 0, bottom: 0, height: 'min(560px, 72vh)',
      background: '#fff', borderTop: '1px solid #bdc1c6', display: 'flex',
      flexDirection: 'column', zIndex: 50, fontSize: 12, color: C.text,
      fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    }}>
      {/* tab strip */}
      <div style={{ height: 30, display: 'flex', alignItems: 'stretch', background: C.chromeBg, borderBottom: '1px solid #d9dce1', flex: 'none' }}>
        {(['timeline', 'sources', 'settings'] as const).map((t) => (
          <div key={t} style={tabStyle(tab === t)} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </div>
        ))}
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 12px', fontSize: 10.5, color: C.dim }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 14, height: 5, borderRadius: 3, background: C.agent, display: 'inline-block' }} /> agent
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 14, height: 5, display: 'inline-block', borderRadius: 3, background: 'repeating-linear-gradient(135deg, rgba(26,115,232,.45) 0 4px, rgba(26,115,232,.12) 4px 9px)' }} /> waiting
          </span>
          {toolsSeen.map((t) => (
            <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Badge color={toolColor(t)} letter={letterOf(t)} size={15} /> {t}
            </span>
          ))}
          <span style={{ fontFamily: mono, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: live ? C.ok : C.faint }} />
            {live ? 'live' : m.runStartAt === null ? 'idle' : 'run complete'}
          </span>
          <span style={{ cursor: 'pointer', color: C.dim }} onClick={onClose} title="collapse to the cog">✕</span>
        </div>
      </div>

      {/* body */}
      {tab === 'timeline' && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <Timeline m={m} rev={rev} store={store} selAgent={selAgent} onSelect={setSelAgent} toolColor={toolColor} />
          {selAgent !== null && m.lanes.has(selAgent) && (
            <AgentFeed m={m} lane={m.lanes.get(selAgent)!} toolColor={toolColor} onClose={() => setSelAgent(null)} onJump={setSelAgent} />
          )}
        </div>
      )}
      {tab === 'sources' && <Sources m={m} toolColor={toolColor} />}
      {tab === 'settings' && <Settings m={m} controls={controls} send={(c) => store.send(c)} />}

      {/* status bar */}
      <div style={{
        height: 24, display: 'flex', alignItems: 'center', gap: 14, padding: '0 12px',
        borderTop: `1px solid ${C.border}`, background: '#f8f9fa', fontSize: 10.5, color: C.dim, flex: 'none',
      }}>
        <span style={{ fontFamily: mono }}>
          {m.runStartAt === null
            ? 'no run yet'
            : `run 0:00 – ${fmtS(live ? (performance.now() - m.runStartAt) / 1000 : runEndS(m))} · ${lanes.length} agents (${done} done) · ${m.retrievals.length} tool calls`}
          {title ? ` · ${title}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ color: C.faint }}>
          {tab === 'timeline' && 'click a lane or badge → detail · esc closes · drag pans (detaches follow) · double-click re-follows'}
          {tab === 'sources' && 'what entered the context — every number is a recorded event field'}
          {tab === 'settings' && 'session-tier controls apply next run · boot rows are fixed for this run'}
        </span>
      </div>
    </div>
  );
}

// ═══ shared atoms ═══
function Badge({ color, letter, size = 18, hollow = false, title }: {
  color: string; letter: string; size?: number; hollow?: boolean; title?: string;
}): ReactElement {
  return (
    <span title={title} style={{
      width: size, height: size, borderRadius: '50%', flex: 'none',
      display: 'inline-grid', placeItems: 'center',
      background: hollow ? '#fff' : color,
      color: hollow ? color : '#fff',
      border: hollow ? `2px solid ${color}` : '2px solid #fff',
      boxShadow: '0 1px 2px rgba(0,0,0,.18)',
      fontSize: size * 0.53, fontWeight: 700, fontFamily: 'system-ui, sans-serif',
    }}>{letter}</span>
  );
}

// ═══ Timeline ═══
const SPAN_LIVE = 75; // seconds visible while following

function Timeline({ m, rev, store, selAgent, onSelect, toolColor }: {
  m: PaneModel; rev: number; store: DevStore;
  selAgent: number | null; onSelect: (id: number | null) => void;
  toolColor: (t: string) => string;
}): ReactElement {
  const [follow, setFollow] = useState(true);
  const [panWindow, setPanWindow] = useState<{ w0: number; w1: number } | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; w0: number; w1: number } | null>(null);

  const t0 = m.runStartAt;
  const live = isLive(m);
  const paintedAt = store.getState().paintedAt;
  // The stepped live edge: quantized to the repaint grid, never per-token.
  const nowS = t0 === null ? 0 : Math.floor(((paintedAt - t0) / 1000) / (EDGE_STEP / 1000)) * (EDGE_STEP / 1000);
  const endS = live ? nowS : runEndS(m);

  // The WINDOW: fixed span; parked at the run start, then SLIDES — never grows.
  let w0: number; let w1: number;
  if (panWindow && !follow) ({ w0, w1 } = panWindow);
  else if (live) {
    if (nowS <= SPAN_LIVE) { w0 = 0; w1 = SPAN_LIVE; }
    else { w0 = Math.floor(nowS - SPAN_LIVE * 0.85); w1 = w0 + SPAN_LIVE; }
  } else { w0 = -2; w1 = Math.max(SPAN_LIVE, endS + 6); }

  const GUTTER = 168;
  const width = trackRef.current?.clientWidth ?? 900;
  const track = Math.max(50, width - GUTTER);
  const px = (s: number): number => GUTTER + ((s - w0) / (w1 - w0)) * track;
  const on = (s: number): boolean => s >= w0 && s <= w1;
  const secOf = (at: number): number => (t0 === null ? 0 : (at - t0) / 1000);

  const span = w1 - w0;
  const step = span > 240 ? 60 : span > 120 ? 30 : span > 60 ? 15 : 5;
  const ticks: number[] = [];
  for (let t = Math.ceil(w0 / step) * step; t <= w1; t += step) ticks.push(t);

  const lanes = [...m.lanes.values()];
  const strip = pressureStrip(m, 200);
  const pct = pressurePercent(m);

  const onMouseDown = (e: React.MouseEvent): void => { drag.current = { x: e.clientX, w0, w1 }; };
  const onMouseMove = (e: React.MouseEvent): void => {
    if (!drag.current) return;
    if (Math.abs(e.clientX - drag.current.x) > 3 && follow) setFollow(false);
    const dt = ((drag.current.x - e.clientX) / track) * (drag.current.w1 - drag.current.w0);
    setPanWindow({ w0: drag.current.w0 + dt, w1: drag.current.w1 + dt });
  };
  const onMouseUp = (): void => { drag.current = null; };

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* pressure strip */}
      <div style={{ height: 40, borderBottom: `1px solid ${C.border}`, display: 'flex', flex: 'none' }}>
        <div style={{ width: GUTTER, flex: 'none', padding: '5px 0 0 14px' }}>
          <div style={label}>pressure</div>
          <div style={{ fontFamily: mono, fontSize: 10.5, color: C.dim }}>
            {pct === null ? '—' : `${pct}% · ${m.pressure[m.pressure.length - 1]?.cellsUsed.toLocaleString()} / ${m.pressure[m.pressure.length - 1]?.nCtx.toLocaleString()}`}
          </div>
        </div>
        <div style={{ flex: 1, position: 'relative' }}>
          {strip.length > 1 && t0 !== null && (
            <svg width="100%" height="40" preserveAspectRatio="none" style={{ display: 'block' }}>
              <polyline
                fill="rgba(26,115,232,.12)" stroke="none"
                points={`${strip.map((p) => `${((secOf(p.at) - w0) / span) * 100}%`.length && `${(((secOf(p.at) - w0) / span) * track).toFixed(1)},${(38 - (p.pct / 100) * 85).toFixed(1)}`).join(' ')} ${(((secOf(strip[strip.length - 1].at) - w0) / span) * track).toFixed(1)},40 ${(((secOf(strip[0].at) - w0) / span) * track).toFixed(1)},40`}
              />
              <polyline
                fill="none" stroke={C.agent} strokeWidth="1.5"
                points={strip.map((p) => `${(((secOf(p.at) - w0) / span) * track).toFixed(1)},${(38 - (p.pct / 100) * 85).toFixed(1)}`).join(' ')}
              />
            </svg>
          )}
        </div>
      </div>

      {/* ruler */}
      <div style={{ height: 20, display: 'flex', borderBottom: `1px solid ${C.border}`, flex: 'none' }}>
        <div style={{ width: GUTTER, flex: 'none', padding: '4px 0 0 14px' }}>
          <span style={label}>{lanes.length ? `${lanes.length} agents` : ''}</span>
        </div>
        <div style={{ flex: 1, position: 'relative', fontFamily: mono }}>
          {ticks.map((t) => (
            <span key={t} style={{ position: 'absolute', left: px(t) - GUTTER, fontSize: 9, color: C.faint }}>
              {t >= 60 ? `${Math.floor(t / 60)}m${t % 60 ? String(t % 60).padStart(2, '0') : ''}` : `${t}s`}
            </span>
          ))}
        </div>
      </div>

      {/* lanes */}
      <div
        ref={trackRef}
        style={{ flex: 1, position: 'relative', overflowY: 'auto', overflowX: 'hidden', cursor: drag.current ? 'grabbing' : undefined }}
        onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}
        onDoubleClick={() => { setFollow(true); setPanWindow(null); }}
      >
        {/* grid + now */}
        <div style={{ position: 'absolute', left: GUTTER, right: 0, top: 0, bottom: 0, pointerEvents: 'none' }}>
          {ticks.map((t) => (
            <div key={t} style={{ position: 'absolute', left: px(t) - GUTTER, top: 0, bottom: 0, width: 1, background: t % (step * 3) === 0 ? C.border : C.hair }} />
          ))}
          {live && on(nowS) && (
            <>
              <div style={{ position: 'absolute', left: px(nowS) - GUTTER, right: 0, top: 0, bottom: 0, background: C.panelBg }} />
              <div style={{ position: 'absolute', left: px(nowS) - GUTTER, top: 0, bottom: 0, width: 1, background: C.text, zIndex: 1 }} />
              <div style={{ position: 'absolute', left: px(nowS) - GUTTER, top: 2, transform: 'translateX(-50%)', fontSize: 8.5, background: C.text, color: '#fff', padding: '0 5px', borderRadius: 2, zIndex: 2, fontFamily: mono }}>now</div>
            </>
          )}
        </div>

        {lanes.map((l) => (
          <Lane
            key={l.agentId} m={m} l={l} px={px} on={on} secOf={secOf} nowS={nowS} live={live}
            selected={selAgent === l.agentId} toolColor={toolColor}
            onClick={() => onSelect(selAgent === l.agentId ? null : l.agentId)}
            gutter={GUTTER} windowEnd={w1}
          />
        ))}
      </div>
    </div>
  );
}

const label: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: '#b0b6c2',
};

function Lane({ m, l, px, on, secOf, nowS, live, selected, toolColor, onClick, gutter, windowEnd }: {
  m: PaneModel; l: AgentLane;
  px: (s: number) => number; on: (s: number) => boolean; secOf: (at: number) => number;
  nowS: number; live: boolean; selected: boolean;
  toolColor: (t: string) => string; onClick: () => void; gutter: number; windowEnd: number;
}): ReactElement {
  const s = secOf(l.spawnedAt);
  const e = l.doneAt === null ? nowS : secOf(l.doneAt);
  const capL = px(s);
  const capR = px(Math.min(e, windowEnd));
  const running = l.doneAt === null;
  const color = l.outcome === 'failed' ? C.fail : l.role === 'synth' ? C.agentDark : C.agent;
  const rgb = l.outcome === 'failed' ? '179,38,30' : l.role === 'synth' ? '23,78,166' : '26,115,232';

  const myCalls = m.retrievals.filter((r) => r.agentId === l.agentId);
  const myGuards = m.interventions.filter((iv) => iv.agentId === l.agentId && iv.kind !== 'nudge');

  const stripe = (x0: number, x1: number, grey = false): ReactElement | null => {
    if (x1 <= x0) return null;
    const g = grey ? '95,99,104' : rgb;
    return (
      <div key={`w${x0}`} style={{
        position: 'absolute', top: 12, height: 14, left: x0 - gutter, width: x1 - x0,
        background: `repeating-linear-gradient(135deg, rgba(${g},.45) 0 4px, rgba(${g},.08) 4px 9px), #fff`,
      }} />
    );
  };

  const glyph = l.outcome === 'failed' ? '✗' : l.outcome === 'recovered' ? '↻' : '✓';
  const glyphBg = l.outcome === 'failed' ? C.fail : l.outcome === 'recovered' ? C.agent : C.ok;
  const endLabel = l.role === 'planner' && m.plan
    ? `plan · ${m.plan.tasks.length} tasks · ${fmtS(e - s)}`
    : l.outcome === 'recovered' ? `recovered · ${fmtS(e - s)}`
      : l.outcome === 'failed' ? `${l.failReason ?? l.dropReason ?? 'failed'} · ${fmtS(e - s)}` : fmtS(e - s);
  const endColor = l.outcome === 'failed' ? C.fail : l.outcome === 'recovered' ? C.agent : '#3c4043';

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', height: 38, borderTop: `1px solid ${C.hair}`, position: 'relative', cursor: 'pointer',
        background: selected ? C.chromeBg : undefined,
        boxShadow: selected ? `inset 3px 0 0 ${C.text}` : undefined,
      }}
    >
      {/* The gutter carries the STABLE identity — the agentId every surface
          shares (the app's cards show the same number). Parentage is detail:
          it lives in the feed header, not on every lane. */}
      <div style={{ width: gutter, flex: 'none', display: 'flex', alignItems: 'baseline', gap: 6, padding: '12px 0 0 14px', fontSize: 11.5 }}>
        <span style={{ fontWeight: 600 }}>{l.role ?? 'agent'}</span>
        <span style={{ color: C.dim, fontSize: 10.5, fontFamily: mono }}>#{l.agentId}</span>
      </div>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {capR > gutter && capL < px(windowEnd) && (
          <>
            <div style={{
              position: 'absolute', top: 12, height: 14,
              left: Math.max(capL, gutter) - gutter,
              width: Math.max(4, capR - Math.max(capL, gutter)),
              background: color,
              borderRadius: running ? '7px 0 0 7px' : capL < gutter ? '0 7px 7px 0' : 7,
            }} />
            {/* settled waits cut into the bar */}
            {myCalls.filter((r) => r.settledAt !== null).map((r) =>
              stripe(
                Math.max(px(secOf(r.dispatchedAt)), Math.max(capL, gutter)),
                Math.min(px(Math.min(secOf(r.settledAt!), e)), capR),
              ))}
            {/* a live wait stripes to the edge; a PARKED retry (rate-limit
                wait) renders grey from the park moment — waiting on the
                outside world, not the tool */}
            {myCalls.filter((r) => r.settledAt === null).map((r) => {
              const from = Math.max(px(secOf(r.dispatchedAt)), Math.max(capL, gutter));
              if (!r.retry) return stripe(from, capR);
              const parkFrom = Math.max(px(secOf(r.retry.at)), Math.max(capL, gutter));
              return (
                <React.Fragment key={`lw${r.dispatchedAt}`}>
                  {stripe(from, Math.min(parkFrom, capR))}
                  {stripe(Math.min(parkFrom, capR), capR, true)}
                </React.Fragment>
              );
            })}
            {/* the planner waiting on the USER — same grammar, grey */}
            {l.clarify && stripe(
              Math.max(px(secOf(l.clarify.askedAt)), Math.max(capL, gutter)),
              Math.min(px(l.clarify.answeredAt === null ? e : secOf(l.clarify.answeredAt)), capR),
              true,
            )}
            {running && live && (
              <span style={{
                position: 'absolute', left: capR - gutter - 3, top: 15.5, width: 7, height: 7,
                borderRadius: '50%', background: C.agentDark, zIndex: 2,
              }} />
            )}
          </>
        )}

        {/* clarify ? badges */}
        {l.clarify && on(secOf(l.clarify.askedAt)) && (
          <span style={{ position: 'absolute', left: px(secOf(l.clarify.askedAt)) - gutter - 9, top: 8.5, zIndex: 2 }}
            title={`asked the user — ${l.clarify.questions.join(' · ')}`}>
            <Badge color={C.dim} letter="?" hollow />
          </span>
        )}
        {l.clarify?.answeredAt != null && on(secOf(l.clarify.answeredAt)) && (
          <span style={{ position: 'absolute', left: px(secOf(l.clarify.answeredAt)) - gutter - 9, top: 8.5, zIndex: 2 }}
            title="the user replied">
            <Badge color={C.dim} letter="?" />
          </span>
        )}

        {/* guard ⊘ badges */}
        {myGuards.filter((g) => g.kind === 'guard' || g.kind === 'auth').map((g, i) =>
          on(secOf(g.at)) ? (
            <span key={`g${i}`} style={{ position: 'absolute', left: px(secOf(g.at)) - gutter - 9, top: 8.5, zIndex: 2 }}
              title={`blocked — ${g.guard ?? g.kind}: ${g.message ?? g.tool ?? ''}`}>
              <Badge color={C.warn} letter="⊘" hollow />
            </span>
          ) : null)}

        {/* tool badges: hollow call, solid result, red error; call yields under 20px */}
        {myCalls.map((r, i) => {
          const cs = secOf(r.dispatchedAt);
          const ce = r.settledAt === null ? null : secOf(r.settledAt);
          const err = r.result !== null && r.result.includes('"error"');
          const collides = ce !== null && px(ce) - px(cs) < 20;
          return (
            <React.Fragment key={`c${i}`}>
              {on(cs) && !collides && (
                <span style={{ position: 'absolute', left: px(cs) - gutter - 9, top: 8.5, zIndex: 2 }}
                  title={`${r.tool} · ${r.args.slice(0, 140)}`}>
                  <Badge color={toolColor(r.tool)} letter={letterOf(r.tool)} hollow />
                </span>
              )}
              {ce !== null && on(ce) && (
                <span style={{ position: 'absolute', left: px(ce) - gutter - 9, top: 8.5, zIndex: 2 }}
                  title={`${r.tool} → ${fmtS(ce - cs)}${r.contextAvailablePercent != null ? ` · ctx ${r.contextAvailablePercent}%` : ''}`}>
                  <Badge color={err ? C.fail : toolColor(r.tool)} letter={letterOf(r.tool)} />
                </span>
              )}
            </React.Fragment>
          );
        })}

        {/* outcome */}
        {l.doneAt !== null && on(e) && (
          <>
            <span style={{ position: 'absolute', left: px(e) - gutter + 8, top: 8.5, zIndex: 2 }}>
              <span style={{
                width: 18, height: 18, borderRadius: '50%', display: 'inline-grid', placeItems: 'center',
                background: glyphBg, color: '#fff', border: '2px solid #fff',
                boxShadow: '0 1px 2px rgba(0,0,0,.18)', fontSize: 10, fontWeight: 700,
              }}>{glyph}</span>
            </span>
            <span style={{
              position: 'absolute', left: px(e) - gutter + 33, top: 13, fontSize: 10.5,
              fontFamily: mono, color: endColor, whiteSpace: 'nowrap', pointerEvents: 'none',
            }}>{endLabel}</span>
          </>
        )}
        {running && on(e) && (
          <span style={{
            position: 'absolute', left: px(e) - gutter + 10, top: 13, fontSize: 10.5,
            fontFamily: mono, color: C.agentDark, whiteSpace: 'nowrap', pointerEvents: 'none',
          }}>{(() => {
            if (l.clarify && l.clarify.answeredAt === null) return 'waiting on you…';
            if (l.inflightTool) {
              const parked = m.retrievals.find((r) => r.agentId === l.agentId && r.settledAt === null && r.retry !== null);
              if (parked?.retry) {
                const left = Math.ceil((parked.retry.afterMs - (nowS - secOf(parked.retry.at)) * 1000) / 1000);
                return left > 0
                  ? `${l.inflightTool} — rate-limited · retry in ${left}s`
                  : `${l.inflightTool} — retrying (attempt ${parked.retry.attempt + 1})…`;
              }
              return `${l.inflightTool}…`;
            }
            return l.role === 'synth' ? 'streaming report…' : 'thinking…';
          })()}</span>
        )}
      </div>
    </div>
  );
}

// ═══ agent detail: the story feed ═══
function AgentFeed({ m, lane, toolColor, onClose, onJump }: {
  m: PaneModel; lane: AgentLane; toolColor: (t: string) => string;
  onClose: () => void; onJump: (id: number) => void;
}): ReactElement {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['report']));
  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const calls = m.retrievals.map((r, i) => ({ r, id: `c${i}` })).filter(({ r }) => r.agentId === lane.agentId);
  const interventions = m.interventions.filter((iv) => iv.agentId === lane.agentId);
  const items: Array<{ at: number; el: ReactElement }> = [];

  if (lane.clarify) {
    items.push({
      at: lane.clarify.askedAt,
      el: (
        <div key="clarify" style={feedItem}>
          <div style={{ display: 'flex', gap: 7, alignItems: 'baseline' }}>
            <b style={{ color: C.dim }}>? asked the user</b>
            <span style={{ color: '#3c4043' }}>“{lane.clarify.questions.join(' · ')}”</span>
          </div>
          <div style={{ margin: '3px 0 0 16px', color: lane.clarify.answeredAt === null ? C.warn : C.dim }}>
            {lane.clarify.answeredAt === null
              ? 'waiting on the user…'
              : `the user replied · ${fmtS((lane.clarify.answeredAt - lane.clarify.askedAt) / 1000)}`}
          </div>
        </div>
      ),
    });
  }

  for (const iv of interventions) {
    items.push({
      at: iv.at,
      el: (
        <div key={`iv${iv.at}`} style={{ ...feedItem, color: C.warn }}>
          <div style={{ display: 'flex', gap: 7, alignItems: 'baseline' }}>
            <b>{iv.kind === 'nudge' ? '▲ harness nudge' : '⊘ blocked'}</b>
            {iv.tool && <span style={{ fontFamily: mono, fontSize: 10.5 }}>{iv.tool}{iv.args ? ` · ${iv.args.slice(0, 80)}` : ''}</span>}
          </div>
          <div style={{ margin: '2px 0 0 16px', color: C.dim }}>
            {iv.guard ? `${iv.guard} guard — ` : iv.reason ? `${iv.reason} — ` : ''}
            {iv.message ? `“${iv.message}”` : ''}
          </div>
        </div>
      ),
    });
  }

  for (const { r, id } of calls) {
    const open = expanded.has(id);
    const err = r.result !== null && r.result.includes('"error"');
    const status = r.settledAt === null
      ? (r.retry ? `rate-limited · parked ${Math.round(r.retry.afterMs / 1000)}s · attempt ${r.retry.attempt}` : 'in flight')
      : r.admission
        ? `${r.admission.selectedPassageCount}${r.admission.totalScored != null ? ` of ${r.admission.totalScored}` : ''} passages${r.admission.admittedTokens != null ? ` · ${r.admission.admittedTokens} tok` : ''}`
        : err ? 'error' : 'done';
    items.push({
      at: r.dispatchedAt,
      el: (
        <div key={id} style={feedItem}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }} onClick={() => toggle(id)}>
            <span style={{ color: C.faint, fontSize: 9, width: 9, flex: 'none' }}>{open ? '▾' : '▸'}</span>
            <Badge color={err ? C.fail : toolColor(r.tool)} letter={letterOf(r.tool)} size={14} />
            <span style={{ fontFamily: mono, fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{r.args}</span>
            <span style={{ color: err ? C.fail : C.faint, fontSize: 10.5 }}>{status}</span>
          </div>
          {open && (
            <div style={{ margin: '6px 0 2px 16px', fontSize: 11 }}>
              {r.explore === false && (
                <div style={{ color: C.faint, marginBottom: 3 }}>exploit — re-ranked against the query</div>
              )}
              {r.admission?.topResults.map((t, i) => (
                <div key={i} style={{ padding: '3px 0', borderTop: `1px solid ${C.hair}` }}>
                  <b style={{ fontSize: 11 }}>{i + 1} · {t.heading}</b>
                  {t.textPreview && <div style={{ color: C.dim, fontSize: 10.5, lineHeight: 1.45 }}>{t.textPreview}…</div>}
                </div>
              ))}
              {!r.admission && r.result && (
                <div style={{ padding: '3px 0', color: err ? C.fail : C.dim, fontSize: 10.5, wordBreak: 'break-word' }}>
                  {r.result.slice(0, 400)}{r.result.length > 400 ? '…' : ''}
                </div>
              )}
            </div>
          )}
        </div>
      ),
    });
  }

  items.sort((a, b) => a.at - b.at);

  // The planner's report IS the plan — structure, with task→agent jumps.
  const research = [...m.lanes.values()].filter((l) => l.role === 'research');
  const planView = lane.role === 'planner' && m.plan && (
    <div style={feedItem}>
      <div style={{ display: 'flex', gap: 7, alignItems: 'baseline', marginBottom: 3 }}>
        <b style={{ fontSize: 11 }}>plan</b>
        <span style={{ color: C.faint }}>{m.plan.tasks.length} tasks — click one to follow its agent</span>
      </div>
      {m.plan.tasks.map((task, i) => {
        const ag = research[i]; // fanout order = flat-mode spawn order
        const g = !ag ? '' : ag.outcome === 'failed' ? '✗' : ag.outcome === 'recovered' ? '↻' : ag.doneAt === null ? '…' : '✓';
        const gc = !ag ? C.faint : ag.outcome === 'failed' ? C.fail : ag.outcome === 'recovered' ? C.agent : C.ok;
        return (
          <div key={i}
            onClick={ag ? () => onJump(ag.agentId) : undefined}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: `1px solid ${C.hair}`, cursor: ag ? 'pointer' : 'default' }}>
            <span style={{ width: 16, textAlign: 'right', fontFamily: mono, fontSize: 10, color: C.faint }}>{i + 1}</span>
            <span style={{ flex: 1, fontSize: 11, lineHeight: 1.4 }}>{task}</span>
            {ag && <span style={chip}>{`research ${ag.agentId}`}</span>}
            <b style={{ color: gc, width: 14, textAlign: 'center' }}>{g}</b>
          </div>
        );
      })}
    </div>
  );

  const reportOpen = expanded.has('report');
  return (
    <div style={{
      width: 420, flex: 'none', borderLeft: '1px solid #d9dce1', display: 'flex',
      flexDirection: 'column', minHeight: 0, background: C.panelBg,
    }}>
      <div style={{
        height: 30, flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px',
        borderBottom: `1px solid ${C.border}`, background: '#f8f9fa',
      }}>
        <span style={{ fontFamily: mono, fontWeight: 600, fontSize: 11 }}>{lane.role ?? 'agent'} {lane.agentId}</span>
        <span style={chip}>parent {lane.parentAgentId ?? '?'}</span>
        <span style={chip}>{lane.outcome}{lane.doneAt !== null && m.runStartAt !== null ? ` · ${fmtS((lane.doneAt - lane.spawnedAt) / 1000)}` : ''}</span>
        <span style={{ flex: 1 }} />
        <span style={{ cursor: 'pointer', color: C.dim }} onClick={onClose} title="close — the timeline returns to full width">✕</span>
      </div>
      <div style={{ overflowY: 'auto', flex: 1, fontSize: 11, paddingBottom: 8 }}>
        {lane.entropy.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 12px', borderBottom: `1px solid ${C.border}` }}>
            <span style={{ color: C.dim, width: 92, flex: 'none' }}>epistemics</span>
            <span style={{ fontFamily: mono, fontSize: 10, color: C.agent, letterSpacing: 1 }} title="entropy — the model's uncertainty per recent token">
              {sparkOf(lane.entropy, 36)}
            </span>
            <span style={{ fontFamily: mono, fontSize: 10, color: C.faint }}>
              H {lane.entropy[lane.entropy.length - 1]?.toFixed(2)} · s {lane.surprisal[lane.surprisal.length - 1]?.toFixed(2)}
            </span>
          </div>
        )}
        {(lane.failReason || lane.dropReason) && (
          <div style={{ display: 'flex', alignItems: 'baseline', padding: '6px 12px', gap: 8 }}>
            <span style={{ color: C.dim, width: 92, flex: 'none' }}>pool said</span>
            <span style={{ fontFamily: mono, fontSize: 11 }}>{lane.dropReason ?? lane.failReason}</span>
          </div>
        )}
        {items.map((it) => it.el)}
        {planView}
        {lane.role !== 'planner' && (lane.report !== null || lane.outcome === 'failed') && (
          <div style={feedItem}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }} onClick={() => toggle('report')}>
              <span style={{ color: C.faint, fontSize: 9, width: 9, flex: 'none' }}>{reportOpen ? '▾' : '▸'}</span>
              <b style={{ fontSize: 11 }}>report</b>
              <span style={{ color: C.faint }}>
                {lane.report === null ? 'not delivered' : lane.reportSource === 'recovery' ? 'extracted by recovery' : 'delivered'}
              </span>
            </div>
            {reportOpen && lane.report !== null && (
              <div style={{ margin: '6px 0 2px 16px', lineHeight: 1.5, color: '#3c4043', whiteSpace: 'pre-wrap' }}>
                {lane.report}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const feedItem: React.CSSProperties = { padding: '7px 12px', borderTop: '1px solid #eceef1' };
const chip: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 2, background: C.chromeBg, color: C.dim,
};

// ═══ Sources: the admission view ═══
function Sources({ m, toolColor }: { m: PaneModel; toolColor: (t: string) => string }): ReactElement {
  const settled = m.retrievals.filter((r) => r.settledAt !== null);
  const [pinned, setPinned] = useState<number | null>(null);
  const sel = pinned !== null && pinned < settled.length ? pinned : settled.length - 1;
  const r = settled[sel];
  const blocked = m.interventions.filter((iv) => iv.kind === 'guard' || iv.kind === 'auth');

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div style={{ width: 300, flex: 'none', borderRight: '1px solid #d9dce1', overflowY: 'auto' }}>
        {settled.length === 0 && blocked.length === 0 && (
          <div style={{ padding: '16px 14px', color: C.faint, fontSize: 11 }}>no results yet</div>
        )}
        {settled.map((x, i) => {
          const err = x.result !== null && x.result.includes('"error"');
          return (
            <div key={i} onClick={() => setPinned(i)} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 11,
              borderBottom: `1px solid ${C.hair}`, cursor: 'pointer',
              background: i === sel ? C.chromeBg : undefined,
              boxShadow: i === sel ? `inset 3px 0 0 ${C.text}` : undefined,
            }}>
              <Badge color={err ? C.fail : toolColor(x.tool)} letter={letterOf(x.tool)} size={16} />
              <span style={{ fontFamily: mono, fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{x.args}</span>
              <span style={{ fontFamily: mono, fontSize: 10, color: C.faint }}>
                {x.settledAt !== null ? fmtS((x.settledAt - x.dispatchedAt) / 1000) : ''}
              </span>
            </div>
          );
        })}
        {blocked.map((g, i) => (
          <div key={`b${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 11, borderBottom: `1px solid ${C.hair}`, opacity: 0.65 }}>
            <Badge color={C.warn} letter="⊘" size={16} hollow />
            <span style={{ fontFamily: mono, fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{g.args ?? g.tool ?? ''}</span>
            <span style={{ fontSize: 10.5, color: C.warn }}>blocked</span>
          </div>
        ))}
      </div>
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', fontSize: 11.5 }}>
        {r && <AdmissionView r={r} />}
      </div>
    </div>
  );
}

function AdmissionView({ r }: { r: Retrieval }): ReactElement {
  let parsed: Record<string, unknown> | null = null;
  try { parsed = r.result ? (JSON.parse(r.result) as Record<string, unknown>) : null; } catch { /* not JSON */ }
  const error = parsed && typeof parsed.error === 'string' ? parsed.error : null;
  const alsoOnPage = parsed && Array.isArray(parsed.alsoOnPage) ? (parsed.alsoOnPage as string[]) : null;
  const a = r.admission;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: `1px solid ${C.border}`, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: mono, fontSize: 11 }}>{r.tool} · {r.args.slice(0, 160)}</span>
        <span style={{ flex: 1 }} />
        {r.explore === false && (
          <span style={{ ...fchip, background: C.warnBg, color: C.warn }}>exploit — re-ranked against the query</span>
        )}
        {r.explore === true && <span style={fchip}>explore — scored against the agent's task</span>}
        <span style={fchip}>agent {r.agentId}</span>
      </div>

      {error && (
        <div style={{ padding: '8px 14px' }}>
          <b style={{ color: C.fail }}>{error}</b>
          <p style={{ margin: '3px 0 0', color: C.dim, fontSize: 11 }}>the agent was told and pivoted</p>
        </div>
      )}

      {r.exploitChunks && r.exploitChunks.length > 0 && <SlopeChart r={r} />}

      {a && a.topResults.length > 0 && (
        <div style={{ padding: '6px 16px 2px', maxWidth: 760 }}>
          {a.topResults.map((t, i) => {
            const maxScore = Math.max(...a.topResults.map((x) => x.score));
            const rel = maxScore !== 0 ? t.score / maxScore : 1;
            return (
              <div key={i} style={{ padding: '6px 0', borderTop: i ? `1px solid ${C.hair}` : undefined }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ width: 14, textAlign: 'right', fontFamily: mono, fontSize: 10, color: C.faint }}>{i + 1}</span>
                  <span style={{ width: 150, flex: 'none' }}>
                    <span style={{ display: 'block', height: 5, borderRadius: 3, background: C.agent, width: `${Math.max(4, rel * 100)}%` }} />
                  </span>
                  <b style={{ fontSize: 11 }}>{t.heading}</b>
                  <span style={{ flex: 1 }} />
                </div>
                {t.textPreview && (
                  <p style={{ margin: '2px 0 0 21px', color: C.dim, fontSize: 10.5, lineHeight: 1.45 }}>{t.textPreview}…</p>
                )}
              </div>
            );
          })}
          <div style={cutline}>
            {a.tokenBudget != null
              ? `admitted ${a.selectedPassageCount}${a.totalScored != null ? ` of ${a.totalScored}` : ''} · ${a.admittedTokens?.toLocaleString() ?? '?'} of ${a.tokenBudget.toLocaleString()} token budget`
              : a.threshold != null
                ? `admitted ${a.selectedPassageCount}${a.totalScored != null ? ` of ${a.totalScored}` : ''} at the score floor`
                : `admitted ${a.selectedPassageCount}`}
          </div>
          {alsoOnPage && alsoOnPage.length > 0 && (
            <div style={{ padding: '2px 0 10px', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              {alsoOnPage.map((h) => <span key={h} style={{ ...fchip, opacity: 0.7 }}>{h}</span>)}
              <span style={{ color: C.faint, fontSize: 10.5 }}>— left on the page, offered to the agent as topics</span>
            </div>
          )}
        </div>
      )}

      {!a && !error && r.result && (
        <div style={{ padding: '8px 14px', color: C.dim, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxWidth: 760 }}>
          {r.result.slice(0, 2000)}{r.result.length > 2000 ? '…' : ''}
        </div>
      )}
    </div>
  );
}

/** Two rankings of the same chunks, side by side — each column HEADED by the
 *  question it ranks for; crossing lines ARE the re-rank. No legend. */
function SlopeChart({ r }: { r: Retrieval }): ReactElement {
  const chunks = r.exploitChunks!;
  const ROW = 26; const W = 70; const HEAD = 40;
  const byTask = [...chunks].sort((a, b) => b.combinedScore - a.combinedScore);
  const byTool = [...chunks].sort((a, b) => b.toolQueryScore - a.toolQueryScore);
  const H = chunks.length * ROW;
  let agentQ = '';
  try { agentQ = String((JSON.parse(r.args || '{}') as { query?: string }).query ?? ''); } catch { /* raw args */ }

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', padding: '14px 16px 4px', maxWidth: 900 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ height: HEAD, textAlign: 'right' }}>
          <div style={label}>for the agent's task</div>
          {agentQ && <div style={{ fontFamily: mono, fontSize: 10, color: C.faint }}>“{agentQ}”</div>}
        </div>
        {byTool.map((x, i) => (
          <div key={x.heading} style={{ height: ROW, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 7, color: '#3c4043' }}>
            <span style={{ fontSize: 11 }}>{x.heading}</span>
            <span style={{ width: 14, fontFamily: mono, fontSize: 10, color: C.faint }}>{i + 1}</span>
          </div>
        ))}
      </div>
      <svg width={W} height={H} style={{ flex: 'none', margin: `${HEAD}px 10px 0` }}>
        {byTask.map((x, ti) => {
          const li = byTool.indexOf(x);
          return <line key={x.heading} x1={0} y1={li * ROW + 13} x2={W} y2={ti * ROW + 13} stroke={C.agent} strokeWidth={1.8} />;
        })}
      </svg>
      <div style={{ flex: 1.2, minWidth: 0 }}>
        <div style={{ height: HEAD }}>
          <div style={label}>re-ranked for the query</div>
        </div>
        {byTask.map((x, i) => (
          <div key={x.heading} style={{ height: ROW, display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 14, textAlign: 'right', fontFamily: mono, fontSize: 10, color: C.faint }}>{i + 1}</span>
            <span style={{ fontSize: 11, fontWeight: 600 }}>{x.heading}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const fchip: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 3, background: C.chromeBg, color: C.dim,
};
const cutline: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0 4px', color: C.faint, fontSize: 10,
  borderTop: '1px dashed #dadce0', marginTop: 6,
};

// ═══ Settings: category nav → harness (master list + detail) · ability pages ═══

/** What the detail panel knows about each well-known harness key: what it is,
 *  and how to change it. Prose is product copy — one clause per sentence. */
const SETTING_META: Readonly<Record<string, { desc: string; how: string }>> = {
  'defaults.effort': {
    desc: 'Run effort preset — agent budget, planner breadth, recovery cap.',
    how: 'Change it here; it applies to your next run and is remembered locally. The committed default lives in harness.yml → defaults.effort.',
  },
  'defaults.reasoningMode': {
    desc: 'flat runs one research wave over the plan; deep lets agents recurse into sub-plans.',
    how: 'Change it here; it applies to your next run.',
  },
  'sources.outputDir': {
    desc: 'Where per-query run-dirs and the session trace are written. Empty means where the harness started.',
    how: 'Edit harness.yml → sources.outputDir; the next run picks it up.',
  },
  'defaults.maxTurns': {
    desc: 'Turn cap per agent run.',
    how: 'Edit harness.yml → defaults.maxTurns; the next run picks it up.',
  },
  'model.path': {
    desc: 'Filesystem path or catalog id of the reasoning model.',
    how: 'Saved changes load at the next start; this run keeps the model it booted with.',
  },
  'model.reranker': {
    desc: 'The admission judge — a pointwise yes/no reranker that gates what enters the context.',
    how: 'Saved changes load at the next start.',
  },
  'model.nCtx': {
    desc: 'Context window of the one shared llama_context — every branch leases cells out of this budget.',
    how: 'Edit harness.yml → model.llm.context, then restart.',
  },
  'model.branches': {
    desc: 'Concurrent sequences — createContext takes it as nSeqMax. Each sequence holds its own KV lease.',
    how: 'Edit harness.yml → model.llm.branches, then restart.',
  },
  'model.kvCache': {
    desc: 'KV cache type for the attention layers — raise for precision, lower for memory.',
    how: 'Edit harness.yml → model.llm.kvCache, then restart.',
  },
  'model.gpu': {
    desc: 'Which native backend the process loaded — picked once at start. A configured backend fails loud if unavailable, never silently CPU.',
    how: 'A deploy choice: set harness.yml → model.llm.gpu (or LLOYAL_GPU), then restart.',
  },
};

const TIER_NOTE: Record<string, string> = {
  session: 'applies to the next run',
  reload: 'saved now — a restart loads it',
  boot: 'fixed for this run',
};

function Settings({ m, controls, send }: {
  m: PaneModel; controls: readonly DevControl[]; send: (c: unknown) => void;
}): ReactElement {
  const [cat, setCat] = useState('harness');
  const [selKey, setSelKey] = useState<string>(controls[0]?.key ?? 'model.path');
  // The nav lists INSTALLED abilities (`abilities:state` descriptors) — not
  // merely configured ones, or the page you'd use to configure an ability
  // could never appear. Harnesses that don't emit descriptors degrade to the
  // redacted config keys.
  const abilities = m.abilities
    ? m.abilities.map((a) => a.name)
    : m.config && typeof m.config.abilities === 'object' && m.config.abilities !== null
      ? Object.keys(m.config.abilities as Record<string, unknown>)
      : [];

  if (!m.config) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: C.faint, fontSize: 11.5 }}>
        this harness has not emitted config:loaded — the inspector has nothing to show
      </div>
    );
  }

  const navItem = (name: string, on: boolean): ReactElement => (
    <div key={name} onClick={() => setCat(name)} style={{
      padding: '7px 16px', fontSize: 12, cursor: 'pointer',
      color: on ? C.text : C.dim, fontWeight: on ? 600 : 400,
      background: on ? '#fff' : undefined,
      borderLeft: on ? `3px solid ${C.text}` : '3px solid transparent',
    }}>{name}</div>
  );

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div style={{ width: 148, flex: 'none', borderRight: '1px solid #d9dce1', paddingTop: 10, background: C.panelBg, overflowY: 'auto' }}>
        {navItem('harness', cat === 'harness')}
        {abilities.length > 0 && <div style={{ ...label, padding: '12px 16px 3px' }}>abilities</div>}
        {abilities.map((a) => navItem(a, cat === a))}
      </div>
      {cat === 'harness'
        ? <HarnessSettings m={m} controls={controls} send={send} selKey={selKey} onSelect={setSelKey} />
        : <AbilityPage m={m} name={cat} send={send} />}
    </div>
  );
}

function HarnessSettings({ m, controls, send, selKey, onSelect }: {
  m: PaneModel; controls: readonly DevControl[]; send: (c: unknown) => void;
  selKey: string; onSelect: (k: string) => void;
}): ReactElement {
  const config = m.config!;
  const byTier = (tier: string): string[] =>
    Object.entries(KEY_TIERS).filter(([, t]) => t === tier).map(([k]) => k);
  const controlFor = (key: string): DevControl | undefined => controls.find((c) => c.key === key);

  const row = (key: string): ReactElement | null => {
    const ctl = controlFor(key);
    const value = ctl ? ctl.read(config) : readConfigPath(config, key);
    if (value === undefined && !ctl) return null; // skip-if-absent: basic has no defaults block
    const selected = selKey === key;
    return (
      <div key={key} onClick={() => onSelect(key)} style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 14px 5px 11px', minHeight: 36,
        borderLeft: selected ? `3px solid ${C.text}` : '3px solid transparent', cursor: 'pointer',
        background: selected ? C.chromeBg : undefined,
      }}>
        <span style={{ fontFamily: mono, fontSize: 11.5, fontWeight: 500 }}>{key}</span>
        <span style={{ flex: 1 }} />
        {ctl ? (
          <span style={{ display: 'flex', border: '1px solid #dadce0', borderRadius: 4, overflow: 'hidden', width: 276, flex: 'none' }}>
            {ctl.values.map((v) => (
              <span key={v}
                onClick={(e) => { e.stopPropagation(); onSelect(key); send({ type: ctl.command, [ctl.field]: v }); }}
                style={{
                  flex: 1, fontSize: 11, padding: '5px 0', textAlign: 'center', cursor: 'pointer',
                  background: v === value ? C.text : '#fff', color: v === value ? '#fff' : C.dim,
                  fontWeight: v === value ? 500 : 400, borderLeft: '1px solid #e8eaed',
                }}>{v}</span>
            ))}
          </span>
        ) : (
          <span style={{ fontFamily: mono, fontSize: 11, color: C.dim, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {value === undefined || value === null || value === '' ? '—' : String(value)}
            {key === 'model.branches' && <span style={{ color: C.faint }}> → nSeqMax</span>}
          </span>
        )}
      </div>
    );
  };

  const head = (t: string): ReactElement => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '13px 14px 3px' }}>
      <span style={label}>{t}</span>
      <span style={{ color: C.faint, fontSize: 10.5 }}>{TIER_NOTE[t]}</span>
    </div>
  );

  const meta = SETTING_META[selKey];
  const tier = KEY_TIERS[selKey];
  // The exception case, surfaced exactly when true: something outside the
  // manifest set this value. No badges anywhere else.
  const originKey = controlFor(selKey)?.originKey;
  const origin = originKey && m.origin ? m.origin[originKey] : undefined;
  const overridden = origin === 'env' || origin === 'cli';

  return (
    <>
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', paddingBottom: 10 }}>
        {head('session')}
        {byTier('session').map(row)}
        {head('reload')}
        {byTier('reload').map(row)}
        {head('boot')}
        {byTier('boot').map(row)}
      </div>
      <div style={{ width: 400, flex: 'none', borderLeft: '1px solid #d9dce1', overflowY: 'auto', padding: '16px 20px', background: C.panelBg }}>
        {meta ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 500 }}>{selKey}</span>
              {tier && <span style={chip}>{TIER_NOTE[tier]}</span>}
            </div>
            <p style={{ maxWidth: 340, margin: '8px 0 0', fontSize: 12, lineHeight: 1.55, color: '#3c4043' }}>{meta.desc}</p>
            <div style={{ ...label, marginTop: 16 }}>changing it</div>
            <p style={{ maxWidth: 340, margin: '6px 0 0', fontSize: 12, lineHeight: 1.55, color: '#3c4043' }}>{meta.how}</p>
            {overridden && (
              <div style={{
                display: 'flex', alignItems: 'baseline', gap: 8, padding: '8px 11px', marginTop: 14,
                background: C.warnBg, border: `1px solid ${C.warnBorder}`, borderRadius: 4, fontSize: 11, maxWidth: 360,
              }}>
                <b>currently overridden</b>
                <span style={{ color: C.dim }}>
                  {origin === 'env' ? 'an environment variable' : 'a command-line flag'} is overriding the manifest — the value shown is the one in effect.
                </span>
              </div>
            )}
          </>
        ) : (
          <span style={{ color: C.faint }}>select a setting</span>
        )}
        {m.lastSavedTo !== undefined && (
          <div style={{ marginTop: 18, fontFamily: mono, fontSize: 10.5, color: C.dim }}>
            {m.lastSavedTo === null
              ? 'applied for this session — a served session has no local file'
              : `saved → ${m.lastSavedTo} (local, not committed)`}
          </div>
        )}
      </div>
    </>
  );
}

/** Schema-driven field specs, the reference app's grammar: SECRET (x-secret)
 *  / REQUIRED / OPTIONAL badges off the ability's own configSchema. Stored
 *  state is key-presence only — values never travel to the UI. */
interface ConfigFieldSpec {
  key: string;
  badge: 'SECRET' | 'REQUIRED' | 'OPTIONAL';
  secret: boolean;
  description?: string;
  stored: boolean;
}

function fieldsOf(a: AbilityInfo): ConfigFieldSpec[] {
  const props = a.configSchema?.properties;
  if (!props) return [];
  const required = new Set(((a.configSchema as { required?: string[] })?.required) ?? []);
  return Object.entries(props).map(([key, raw]) => {
    const prop = (raw ?? {}) as { 'x-secret'?: boolean; description?: string };
    const secret = prop['x-secret'] === true;
    return {
      key,
      badge: secret ? 'SECRET' : required.has(key) ? 'REQUIRED' : 'OPTIONAL',
      secret,
      description: prop.description,
      stored: a.config[key] !== undefined,
    };
  });
}

/** One editable config field. Values are write-only on this wire — the input
 *  never prefills; the placeholder carries the set-state. Saving dispatches
 *  set_app_config with the entered field (whole-replace semantics until the
 *  per-key merge helper lands — exact for the shipped single-field schemas). */
function AbilityField({ name, field, send }: {
  name: string; field: ConfigFieldSpec; send: (c: unknown) => void;
}): ReactElement {
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState(false);
  const save = (): void => {
    const v = draft.trim();
    if (!v) return;
    send({ type: 'set_app_config', name, values: { [field.key]: v } });
    setDraft('');
    setSaved(true);
  };
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: mono, fontSize: 11.5, fontWeight: 500 }}>{field.key}</span>
        <span style={{
          ...chip,
          background: field.secret ? C.warnBg : C.chromeBg,
          color: field.secret ? C.warn : C.dim,
        }}>{field.badge}</span>
        {(field.stored || saved) && <span style={{ color: C.ok, fontSize: 10.5 }}>set ✓</span>}
      </div>
      {field.description && (
        <div style={{ color: C.faint, fontSize: 10.5, marginTop: 2 }}>{field.description}</div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <input
          type={field.secret ? 'password' : 'text'}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); }}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
          placeholder={field.stored || saved ? 'set ✓ — enter to replace' : 'not set'}
          style={{
            width: 320, fontSize: 11, fontFamily: mono, padding: '5px 8px',
            border: '1px solid #dadce0', borderRadius: 4,
          }}
        />
        <button
          type="button"
          onClick={save}
          style={{
            font: 'inherit', fontSize: 11, border: '1px solid #dadce0', background: C.text,
            color: '#fff', borderRadius: 4, padding: '2px 12px', cursor: 'pointer',
          }}
        >save</button>
      </div>
    </div>
  );
}

/** An ability's page: schema-driven config form (the reference app's field
 *  grammar), write-only on this wire. Falls back to the redacted key-presence
 *  inspector when the harness never sent descriptors. */
function AbilityPage({ m, name, send }: { m: PaneModel; name: string; send: (c: unknown) => void }): ReactElement {
  const info = m.abilities?.find((a) => a.name === name);
  const stored = info?.config
    ?? (m.config?.abilities as Record<string, Record<string, unknown>> | undefined)?.[name]
    ?? {};
  const fields = info ? fieldsOf(info) : [];
  const setCount = fields.length > 0
    ? fields.filter((f) => f.stored).length
    : Object.keys(stored).length;

  return (
    <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '16px 22px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 500 }}>{info?.title ?? name}</span>
        {fields.length > 0 && (
          <span style={{ color: setCount === fields.length ? C.ok : C.dim, fontSize: 10.5 }}>
            {setCount} of {fields.length} set{setCount === fields.length ? ' ✓' : ''}
          </span>
        )}
        <span style={chip}>applies to the next run</span>
        {info && !info.enabled && <span style={{ ...chip, color: C.fail }}>disabled</span>}
      </div>
      {info?.description && (
        <p style={{ maxWidth: 480, margin: '6px 0 0', fontSize: 11.5, color: C.dim }}>{info.description}</p>
      )}
      <p style={{ maxWidth: 480, margin: '6px 0 0', fontSize: 11, color: C.faint }}>
        Values are write-only on this wire — the form shows which keys are set, never what they hold.
      </p>
      {fields.map((f) => <AbilityField key={f.key} name={name} field={f} send={send} />)}
      {fields.length === 0 && Object.keys(stored).map((k) => (
        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
          <span style={{ width: 140, flex: 'none', fontFamily: mono, fontSize: 11.5 }}>{k}</span>
          <span style={{ color: C.ok, fontSize: 11 }}>set ✓</span>
        </div>
      ))}
      {fields.length === 0 && Object.keys(stored).length === 0 && (
        <p style={{ marginTop: 12, color: C.faint, fontSize: 11 }}>this ability declares no config</p>
      )}
    </div>
  );
}
