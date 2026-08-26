/**
 * `<DevPane>` — the dev pane for the shared React view (desktop + web).
 *
 * Mounted ONCE beside the app's own view; it subscribes to the same bridge
 * stream the view folds and renders nothing until `config:loaded` carries
 * `dev: true` (the boot's `LLOYAL_DEV` signal on the wire, so a production
 * build ships this import inert).
 *
 * Visual contract (the approved mocks): monochrome CHROME — black active tab,
 * light-grey active pills, black selection — with color reserved for DATA:
 * agent spans blue, tools amber, rerank teal, the pressure area, the six
 * provenance rungs. FAB-toggled, DOCKED full width when open; the pane's ✕
 * collapses back to the cog. The timeline is full width until a lane is
 * selected; selection opens the detail pane, which closes with its own ✕.
 *
 * @category DevTools
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import {
  createPaneModel,
  foldEvent,
  pressurePercent,
  pressureStrip,
  readConfigPath,
  KEY_TIERS,
} from './index.js';
import type { DevControl, DevEvent, PaneModel, PaneTab } from './index.js';

/** The bridge slice the pane needs — structurally `window.harness`, minus the
 *  snapshot (the pane folds live only; it renders what it has seen). */
export interface DevBridge {
  onEvent(cb: (frame: { seq: number; ev: DevEvent }) => void): () => void;
  send(command: unknown): void;
}

export interface DevPaneProps {
  bridge: DevBridge;
  /** The template's Settings contribution — pure data; `[]` for a template
   *  whose protocol has no config commands (its Settings tab is an
   *  inspector). */
  controls?: readonly DevControl[];
  /** Shown in the pane's file/status area, e.g. the harness name. */
  title?: string;
}

// ── palette: monochrome chrome, colored data ─────────────────────
const C = {
  text: '#202124',
  dim: '#5f6368',
  faint: '#9aa0a6',
  border: '#e8eaed',
  hairline: '#f1f3f4',
  toolbar: '#f8f9fa',
  chipBg: '#f1f3f4',
  pillOn: '#e8eaed',
  agent: '#1a73e8',
  agentAlt: '#669df6',
  tool: '#e0a63f',
  rerank: '#3f9e83',
  fail: '#c5221f',
  pressure: '#1a73e8',
};
const PROV_COLORS: Record<string, { bg: string; fg: string }> = {
  cli: { bg: '#fce8d8', fg: '#b3540a' },
  env: { bg: '#f0e4fc', fg: '#7627bb' },
  file: { bg: '#e8f0fe', fg: '#1a66c9' },
  yml: { bg: '#dcf2ea', fg: '#0d7a55' },
  session: { bg: '#fce4f0', fg: '#b81d75' },
  default: { bg: '#f1f3f4', fg: '#80868b' },
};

const mono: CSSProperties = {
  fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};

function Prov({ rung }: { rung: string }): ReactElement {
  const c = PROV_COLORS[rung] ?? PROV_COLORS.default;
  return (
    <span
      style={{
        fontSize: 9, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase',
        padding: '1px 6px', borderRadius: 8, background: c.bg, color: c.fg,
      }}
    >
      {rung}
    </span>
  );
}

function Cog(): ReactElement {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function DevPane({ bridge, controls = [], title }: DevPaneProps): ReactElement | null {
  // Lazy init — an inline initializer would allocate a fresh model every
  // render only to be discarded after the first.
  const modelRef = useRef<PaneModel | null>(null);
  modelRef.current ??= createPaneModel();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<PaneTab>('timeline');
  const [selectedLane, setSelectedLane] = useState<number | null>(null);
  const [selectedRetrieval, setSelectedRetrieval] = useState<number>(0);

  useEffect(() => {
    // Coalesce re-renders: agent:produce arrives per token — fold immediately,
    // paint at most ~5×/s.
    let dirty = false;
    const timer = setInterval(() => {
      if (dirty) {
        dirty = false;
        bump();
      }
    }, 200);
    const off = bridge.onEvent(({ ev }) => {
      // Truly wire-gated: until config:loaded says dev, fold ONLY that event
      // — a non-dev page never pays the per-token fold.
      const m = modelRef.current!;
      if (m.dev || ev.type === 'config:loaded') {
        foldEvent(m, ev, Date.now());
        dirty = true;
      }
    });
    return () => {
      clearInterval(timer);
      off();
    };
  }, [bridge]);

  const m = modelRef.current;
  if (!m.dev) return null; // the gate: no dev signal, no cog — ever

  if (!open) {
    return (
      <div
        onClick={() => setOpen(true)}
        title="dev pane (LLOYAL_DEV)"
        style={{
          position: 'fixed', right: 20, bottom: 20, width: 44, height: 44, borderRadius: '50%',
          background: '#fff', border: `1px solid #dadce0`, display: 'grid', placeItems: 'center',
          color: C.dim, boxShadow: '0 2px 8px rgba(32,33,36,.14)', cursor: 'pointer', zIndex: 9999,
        }}
      >
        <Cog />
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, height: 'min(560px, 70vh)',
        background: '#fff', borderTop: '1px solid #bdc1c6', display: 'flex', flexDirection: 'column',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        color: C.text, zIndex: 9999, fontSize: 12,
      }}
    >
      {/* tab strip */}
      <div style={{ height: 30, display: 'flex', alignItems: 'stretch', background: C.hairline, borderBottom: '1px solid #d9dce1', flex: 'none' }}>
        {(['timeline', 'sources', 'settings'] as PaneTab[]).map((t) => (
          <div
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '0 13px', display: 'flex', alignItems: 'center', cursor: 'pointer',
              borderRight: `1px solid ${C.border}`, textTransform: 'capitalize',
              ...(tab === t
                ? { background: '#fff', fontWeight: 500, boxShadow: 'inset 0 2px 0 #202124' }
                : { color: C.dim }),
            }}
          >
            {t}
          </div>
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ ...mono, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 7, fontSize: 10.5, color: C.dim }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#188038' }} />
          live · {m.eventCount} events{title ? ` · ${title}` : ''}
        </div>
        <div
          onClick={() => setOpen(false)}
          title="collapse to the cog"
          style={{ width: 32, display: 'grid', placeItems: 'center', cursor: 'pointer', color: C.dim, borderLeft: `1px solid ${C.border}` }}
        >
          ✕
        </div>
      </div>

      {tab === 'timeline' && (
        <Timeline
          m={m}
          selected={selectedLane}
          onSelect={setSelectedLane}
        />
      )}
      {tab === 'sources' && (
        <Sources m={m} selected={selectedRetrieval} onSelect={setSelectedRetrieval} />
      )}
      {tab === 'settings' && <Settings m={m} controls={controls} send={(c) => bridge.send(c)} />}

      {/* status bar */}
      <div style={{ height: 24, flex: 'none', display: 'flex', alignItems: 'center', gap: 14, padding: '0 12px', borderTop: `1px solid ${C.border}`, background: C.toolbar }}>
        {m.facts && (
          <span style={{ ...mono, fontSize: 10.5, color: C.dim }}>
            {m.facts.model.id}{m.facts.surface ? ` · ${m.facts.surface}` : ''}
          </span>
        )}
        {pressurePercent(m) !== null && (
          <span style={{ ...mono, fontSize: 10.5, color: C.faint }}>kv {pressurePercent(m)}% · attention cells</span>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: C.faint }}>LLOYAL_DEV=1 — ships to nobody</span>
      </div>
    </div>
  );
}

// ── Timeline ─────────────────────────────────────────────────────

function fmtS(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function Timeline({
  m, selected, onSelect,
}: {
  m: PaneModel;
  selected: number | null;
  onSelect: (id: number | null) => void;
}): ReactElement {
  const t0 = m.t0 ?? Date.now();
  const tEnd = Math.max(Date.now(), t0 + 1000);
  const span = tEnd - t0;
  const pos = (t: number): string => `${Math.min(100, Math.max(0, ((t - t0) / span) * 100))}%`;
  const width = (a: number, b: number | null): string =>
    `${Math.min(100, Math.max(0.5, (((b ?? tEnd) - a) / span) * 100))}%`;

  const lanes = [...m.lanes.values()];
  const strip = pressureStrip(m, 120);
  const sel = selected !== null ? m.lanes.get(selected) ?? null : null;
  const selRetrievals = sel ? m.retrievals.filter((r) => r.agentId === sel.agentId) : [];

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
        {/* pressure: the compact area strip — data blue, demoted placement */}
        {strip.length > 0 && (
          <div style={{ height: 46, borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', padding: '0 12px', gap: 12 }}>
            <div style={{ width: 130, flex: 'none' }}>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: '#b0b6c2' }}>pressure</div>
              <div style={{ ...mono, fontSize: 10.5, color: C.dim }}>
                {pressurePercent(m)}%{' '}
                <span style={{ color: '#b0b6c2' }}>
                  {m.pressure[m.pressure.length - 1]?.cellsUsed.toLocaleString()} / {m.pressure[m.pressure.length - 1]?.nCtx.toLocaleString()}
                </span>
              </div>
            </div>
            <svg width="100%" height="36" preserveAspectRatio="none" viewBox="0 0 120 36">
              <polyline
                fill="rgba(26,115,232,.12)"
                stroke="none"
                points={`0,36 ${strip.map((p, i) => `${(i / Math.max(1, strip.length - 1)) * 120},${36 - (p.pct / 100) * 32}`).join(' ')} 120,36`}
              />
              <polyline
                fill="none"
                stroke={C.pressure}
                strokeWidth="1"
                points={strip.map((p, i) => `${(i / Math.max(1, strip.length - 1)) * 120},${36 - (p.pct / 100) * 32}`).join(' ')}
              />
            </svg>
          </div>
        )}

        {lanes.length === 0 && (
          <div style={{ padding: '18px 14px', color: C.faint }}>waiting for the first agent — submit a query</div>
        )}

        {lanes.map((lane) => {
          const isSel = selected === lane.agentId;
          return (
            <div
              key={lane.agentId}
              onClick={() => onSelect(isSel ? null : lane.agentId)}
              style={{
                display: 'flex', alignItems: 'center', height: 26, borderTop: `1px solid ${C.hairline}`,
                cursor: 'pointer',
                ...(isSel ? { background: C.hairline, boxShadow: 'inset 3px 0 0 #202124' } : {}),
              }}
            >
              <div style={{ width: 150, flex: 'none', paddingLeft: 12, fontSize: 11, color: isSel ? C.text : C.dim, display: 'flex', gap: 6, alignItems: 'center', fontWeight: isSel ? 500 : 400 }}>
                agent {lane.agentId}
                <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 2, background: isSel ? '#202124' : C.chipBg, color: isSel ? '#fff' : C.dim }}>
                  {lane.outcome === 'running' && lane.inflightTool ? lane.inflightTool : lane.outcome}
                </span>
              </div>
              <div style={{ flex: 1, position: 'relative', height: '100%' }}>
                <div
                  style={{
                    position: 'absolute', top: 7, height: 12, borderRadius: 2,
                    left: pos(lane.spawnedAt), width: width(lane.spawnedAt, lane.doneAt),
                    background: lane.outcome === 'failed' ? C.fail : lane.agentId % 2 ? C.agent : C.agentAlt,
                  }}
                />
                <span style={{ ...mono, position: 'absolute', top: 6, right: 8, fontSize: 9.5, color: C.dim }}>
                  {lane.tokenCount > 0 ? `${lane.tokenCount.toLocaleString()} tok` : ''}
                  {lane.doneAt ? ` · ${fmtS(lane.doneAt - lane.spawnedAt)}` : ''}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* detail — opens on selection, closes with its own ✕ */}
      {sel && (
        <div style={{ width: 340, flex: 'none', borderLeft: '1px solid #d9dce1', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ height: 30, flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', borderBottom: `1px solid ${C.border}`, background: C.toolbar }}>
            <span style={{ ...mono, fontWeight: 600, fontSize: 11 }}>agent {sel.agentId}</span>
            {sel.parentAgentId !== null && (
              <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 2, background: C.chipBg, color: C.dim }}>parent {sel.parentAgentId}</span>
            )}
            <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 2, background: C.chipBg, color: C.dim }}>
              {sel.outcome}{sel.doneAt ? ` · ${fmtS(sel.doneAt - sel.spawnedAt)}` : ''}
            </span>
            <div style={{ flex: 1 }} />
            <span onClick={() => onSelect(null)} style={{ cursor: 'pointer', color: C.dim }} title="close detail — the timeline returns to full width">✕</span>
          </div>
          <div style={{ overflowY: 'auto', flex: 1, fontSize: 11 }}>
            <Row k="tokens" v={sel.tokenCount.toLocaleString()} />
            {sel.failReason && <Row k="failed" v={sel.failReason} />}
            {selRetrievals.map((r, i) => (
              <div key={i} style={{ borderTop: `1px solid ${C.border}`, marginTop: 4, paddingTop: 4 }}>
                <Row k="tool" v={`${r.tool}${r.settledAt ? ` · ${fmtS(r.settledAt - r.dispatchedAt)}` : ' · in flight'}`} />
                <Row k="args" v={r.args.slice(0, 120)} />
                {r.contextAvailablePercent !== null && <Row k="ctx avail" v={`${r.contextAvailablePercent}%`} />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }): ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', padding: '3px 12px', gap: 8 }}>
      <span style={{ color: C.dim, width: 84, flex: 'none' }}>{k}</span>
      <span style={{ ...mono, fontSize: 11, wordBreak: 'break-word' }}>{v}</span>
    </div>
  );
}

// ── Sources ──────────────────────────────────────────────────────

function Sources({
  m, selected, onSelect,
}: {
  m: PaneModel;
  selected: number;
  onSelect: (i: number) => void;
}): ReactElement {
  const rows = m.retrievals;
  const sel = rows[selected] ?? null;
  let parsed: Record<string, unknown> | null = null;
  if (sel?.result) {
    try {
      const p = JSON.parse(sel.result) as unknown;
      if (p && typeof p === 'object') parsed = p as Record<string, unknown>;
    } catch { /* result isn't JSON — render raw below */ }
  }
  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <div style={{ width: 300, flex: 'none', borderRight: '1px solid #d9dce1', overflowY: 'auto' }}>
        {rows.length === 0 && <div style={{ padding: '18px 14px', color: C.faint }}>no tool calls yet</div>}
        {rows.map((r, i) => (
          <div
            key={i}
            onClick={() => onSelect(i)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 11,
              borderBottom: `1px solid ${C.hairline}`, cursor: 'pointer',
              ...(i === selected ? { background: C.hairline, boxShadow: 'inset 3px 0 0 #202124' } : {}),
            }}
          >
            <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 2, background: '#fef7e0', color: '#b06000' }}>{r.tool}</span>
            <span style={{ ...mono, fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{r.args.slice(0, 60)}</span>
            <span style={{ ...mono, fontSize: 10, color: C.faint }}>
              {r.settledAt ? fmtS(r.settledAt - r.dispatchedAt) : '…'}
            </span>
          </div>
        ))}
      </div>
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', fontSize: 11 }}>
        {sel && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: `1px solid ${C.border}` }}>
              <span style={{ ...mono, fontSize: 11 }}>{sel.args.slice(0, 140)}</span>
              <div style={{ flex: 1 }} />
              <span style={{ ...mono, fontSize: 10.5, color: C.dim }}>agent {sel.agentId}</span>
            </div>
            {parsed !== null ? (
              <div style={{ padding: '8px 0' }}>
                {Object.entries(parsed).map(([k, v]) => (
                  <Row
                    key={k}
                    k={k}
                    v={typeof v === 'string' ? v.slice(0, 800) : JSON.stringify(v)?.slice(0, 800) ?? ''}
                  />
                ))}
              </div>
            ) : sel.result ? (
              <pre style={{ ...mono, padding: 14, whiteSpace: 'pre-wrap', fontSize: 11 }}>{sel.result.slice(0, 4000)}</pre>
            ) : (
              <div style={{ padding: '18px 14px', color: C.faint }}>in flight</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Settings ─────────────────────────────────────────────────────

/** The read-only inspector rows every harness gets — the machine's config
 *  surface. The template's own knobs arrive via `controls`. */
const INSPECT_KEYS: readonly { path: string; originKey?: string }[] = [
  { path: 'model.path', originKey: 'modelPath' },
  { path: 'model.reranker', originKey: 'reranker' },
  { path: 'model.nCtx', originKey: 'nCtx' },
  { path: 'model.gpu', originKey: 'gpu' },
  { path: 'model.branches' },
  { path: 'model.kvCache' },
  { path: 'sources.outputDir', originKey: 'outputDir' },
];

function Settings({
  m, controls, send,
}: {
  m: PaneModel;
  controls: readonly DevControl[];
  send: (c: unknown) => void;
}): ReactElement {
  if (!m.config) {
    return (
      <div style={{ flex: 1, padding: '18px 14px', color: C.faint }}>
        this harness has not emitted config:loaded — the inspector has nothing to show
      </div>
    );
  }
  const abilities = (m.config.abilities ?? {}) as Record<string, Record<string, unknown>>;
  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      {/* machine config — the inspector */}
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '14px 18px', borderRight: `1px solid ${C.border}` }}>
        <SectionLabel text="config" sub="value and where it came from" />
        {INSPECT_KEYS.map(({ path, originKey }) => {
          const v = readConfigPath(m.config, path);
          if (v === undefined) return null;
          const rung = originKey && m.origin ? m.origin[originKey] : undefined;
          const tier = KEY_TIERS[path];
          return (
            <div key={path} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderTop: `1px solid ${C.hairline}` }}>
              <span style={{ ...mono, fontSize: 11.5, fontWeight: 500 }}>{path}</span>
              {tier === 'boot' && <span style={{ fontSize: 9.5, color: C.faint }}>fixed for this context</span>}
              <div style={{ flex: 1 }} />
              <span style={{ ...mono, fontSize: 11, color: C.dim, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {String(v)}
              </span>
              {rung && <Prov rung={rung} />}
            </div>
          );
        })}

        {Object.keys(abilities).length > 0 && (
          <>
            <div style={{ height: 14 }} />
            <SectionLabel text="abilities" sub="values are redacted to key-presence — secrets never render back" />
            {Object.entries(abilities).map(([name, cfg]) => (
              <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderTop: `1px solid ${C.hairline}` }}>
                <span style={{ ...mono, fontSize: 11.5, fontWeight: 500 }}>{name}</span>
                <div style={{ flex: 1 }} />
                <span style={{ ...mono, fontSize: 11, color: '#188038' }}>
                  {Object.keys(cfg).length > 0 ? `${Object.keys(cfg).join(', ')} configured ✓` : 'no config'}
                </span>
              </div>
            ))}
          </>
        )}
      </div>

      {/* template controls */}
      <div style={{ width: 360, flex: 'none', overflowY: 'auto', padding: '14px 18px', display: 'flex', flexDirection: 'column' }}>
        <SectionLabel text="run policy" sub={controls.length ? 'how this harness thinks' : 'this template has no runtime controls yet'} />
        {controls.map((ctl) => {
          const current = ctl.read(m.config!);
          const rung = ctl.originKey && m.origin ? m.origin[ctl.originKey] : undefined;
          return (
            <div key={ctl.key} style={{ padding: '10px 0', borderTop: `1px solid ${C.hairline}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
                <span style={{ ...mono, fontSize: 11.5, fontWeight: 500 }}>{ctl.key}</span>
                {rung && <Prov rung={rung} />}
                <div style={{ flex: 1 }} />
                {ctl.note && <span style={{ fontSize: 10, color: '#188038' }}>{ctl.note}</span>}
              </div>
              <div style={{ display: 'flex', border: '1px solid #dadce0', borderRadius: 4, overflow: 'hidden' }}>
                {ctl.values.map((v) => (
                  <div
                    key={v}
                    onClick={() => send({ type: ctl.command, [ctl.field]: v })}
                    style={{
                      flex: 1, fontSize: 11.5, padding: '6px 0', textAlign: 'center', cursor: 'pointer',
                      borderLeft: `1px solid ${C.border}`,
                      ...(v === current ? { background: '#202124', color: '#fff', fontWeight: 500 } : { color: C.dim }),
                    }}
                  >
                    {v}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        <div style={{ flex: 1 }} />
        {/* placement-aware save footer: a real path or the honest session note */}
        {m.lastSavedTo !== undefined && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
            {m.lastSavedTo !== null ? (
              <>
                <Prov rung="file" />
                <span style={{ ...mono, fontSize: 10.5, color: C.dim }}>saved → {m.lastSavedTo}</span>
              </>
            ) : (
              <>
                <Prov rung="session" />
                <span style={{ ...mono, fontSize: 10.5, color: C.dim }}>applied for this session — no file remembers it</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ text, sub }: { text: string; sub?: string }): ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
      <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', color: '#80868b' }}>{text}</span>
      {sub && <span style={{ fontSize: 10.5, color: '#b0b6c2' }}>{sub}</span>}
    </div>
  );
}
