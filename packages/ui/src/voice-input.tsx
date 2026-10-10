import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { ingestMedia } from '@lloyal-labs/media';
import type { VoiceCapabilities, VoiceCommand, VoiceEvent, VoiceResult } from '@lloyal-labs/binding';
import { useAvailability, useContentOrigin, useHarness } from './provider.js';
import { startAudioCapture } from './audio-capture.js';
import type { AudioCapture } from './audio-capture.js';
import { RecordingWaveform } from './recording-waveform.js';

type Phase = 'idle' | 'requesting' | 'recording' | 'uploading' | 'transcribing' | 'ready' | 'error';
interface VoiceState { phase: Phase; levels: number[]; elapsed: number; error?: string; pending?: VoiceResult }
const INITIAL: VoiceState = { phase: 'idle', levels: [], elapsed: 0 };

export interface VoiceInputProps {
  draft: string;
  onDraft(text: string): void;
  /** Current cursor range; otherwise dictation appends to the draft. */
  selection?(): { start: number; end: number };
  /** Changing the destination cancels dictation, for example navigation to another document. */
  destination?: string | null;
  /** Suspend dictation while the containing composer cannot accept edits. */
  disabled?: boolean;
}

export function insertTranscript(draft: string, text: string, range: { start: number; end: number }): string {
  const start = Math.max(0, Math.min(draft.length, range.start));
  const end = Math.max(start, Math.min(draft.length, range.end));
  const before = draft.slice(0, start); const after = draft.slice(end);
  return before + (before && !/\s$/.test(before) ? ' ' : '') + text + (after && !/^\s/.test(after) ? ' ' : '') + after;
}

/** Capture and request state belongs to this draft; the only successful action is an editable text change. */
export function VoiceInput({ draft, onDraft, selection, destination, disabled = false }: VoiceInputProps): ReactElement | null {
  const { bridge } = useHarness<VoiceEvent, VoiceCommand>();
  const origin = useContentOrigin();
  const availability = useAvailability();
  const [capabilities, setCapabilities] = useState<VoiceCapabilities>({ enabled: false });
  const [state, setState] = useState<VoiceState>(INITIAL);
  const latest = useRef({ draft, revision: 0, onDraft, selection, availability });
  if (latest.current.draft !== draft) latest.current.revision++;
  Object.assign(latest.current, { draft, onDraft, selection, availability });
  const active = useRef<{
    id: string; controller: AbortController; capture?: AudioCapture;
    revision: number; draft: string; range: { start: number; end: number };
  } | null>(null);

  const cancel = (): void => {
    const current = active.current; active.current = null;
    if (current) {
      current.controller.abort();
      if (availability === 'ready') bridge.send({ type: 'voice:cancel', requestId: current.id });
    }
    setState(INITIAL);
  };

  useEffect(() => {
    setState(INITIAL);
    setCapabilities({ enabled: false });
    if (availability !== 'ready' || origin === null || disabled) return;
    const unsubscribe = bridge.onEvent(({ ev }) => {
      if (ev.type === 'voice:capabilities') { setCapabilities(ev.capabilities); return; }
      const current = active.current;
      if (!current || !('requestId' in ev) || ev.requestId !== current.id || current.controller.signal.aborted) return;
      if (ev.type === 'voice:progress') setState(s => ({ ...s, phase: 'transcribing' }));
      if (ev.type === 'voice:cancelled') { active.current = null; current.controller.abort(); setState(INITIAL); }
      if (ev.type === 'voice:error') { active.current = null; current.controller.abort(); setState(s => ({ ...s, phase: 'error', error: ev.message })); }
      if (ev.type === 'voice:result') {
        active.current = null;
        current.controller.abort();
        if (!ev.result.text) { setState(s => ({ ...s, phase: 'idle', error: ev.result.silent ? 'The recording was silent.' : 'No transcript was returned.' })); return; }
        if (latest.current.revision === current.revision) {
          latest.current.onDraft(insertTranscript(current.draft, ev.result.text, current.range));
          setState(INITIAL);
        } else {
          setState(s => ({ ...s, phase: 'ready', pending: ev.result }));
        }
      }
    });
    if (availability === 'ready' && origin !== null) bridge.send({ type: 'voice:describe' });
    return () => {
      unsubscribe();
      const current = active.current; active.current = null;
      if (current) {
        current.controller.abort();
        if (latest.current.availability === 'ready') bridge.send({ type: 'voice:cancel', requestId: current.id });
      }
    };
  }, [bridge, availability, origin, destination, disabled]);

  const start = async (): Promise<void> => {
    if (!capabilities.enabled || origin === null || active.current || disabled) return;
    const current = {
      id: crypto.randomUUID(), controller: new AbortController(), revision: latest.current.revision,
      draft: latest.current.draft, range: latest.current.selection?.() ?? { start: draft.length, end: draft.length },
      capture: undefined as AudioCapture | undefined,
    };
    active.current = current;
    const owns = (): boolean => active.current === current && !current.controller.signal.aborted;
    setState({ ...INITIAL, phase: 'requesting' });
    try {
      current.capture = await startAudioCapture({
        signal: current.controller.signal, limits: capabilities.limits,
        onLevel: (level, elapsed) => { if (owns()) setState(s => ({ ...s, levels: [...s.levels.slice(-79), Math.min(1, Math.sqrt(level))], elapsed })); },
      });
      if (!owns()) return;
      setState(s => ({ ...s, phase: 'recording' }));
      const bytes = await current.capture.result;
      if (!owns()) return;
      setState(s => ({ ...s, phase: 'uploading' }));
      const audio = await ingestMedia(origin, bytes, { signal: current.controller.signal });
      if (!owns()) return;
      setState(s => ({ ...s, phase: 'transcribing' }));
      bridge.send({ type: 'voice:transcribe', requestId: current.id, audio });
    } catch (error) {
      if (!owns()) return;
      active.current = null; current.controller.abort();
      setState(s => ({ ...s, phase: 'error', error: error instanceof Error ? error.message : 'Recording failed.' }));
    }
  };

  const insertPending = (): void => {
    if (!state.pending) return;
    const { draft: text, selection: range, onDraft: change } = latest.current;
    change(insertTranscript(text, state.pending.text, range?.() ?? { start: text.length, end: text.length }));
    setState(INITIAL);
  };

  if (!capabilities.enabled || origin === null || availability !== 'ready' || disabled) return null;
  const recording = state.phase === 'recording';
  const busy = ['requesting', 'uploading', 'transcribing'].includes(state.phase);
  const labels: Partial<Record<Phase, string>> = { requesting: 'Allow microphone access', uploading: 'Preparing recording', transcribing: 'Transcribing', ready: 'Transcript ready', error: 'Recording failed' };
  return <div style={{ padding: '12px 0 0', width: '100%' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 10 }}>
      <span style={{ fontSize: 12, color: 'var(--lloyal-voice-muted, #8e8e93)' }}>Voice · {capabilities.model}</span>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        {(recording || busy || state.phase === 'ready') && <button type="button" onClick={cancel} style={textButton}>Cancel</button>}
        {state.phase === 'ready' && <button type="button" style={textButton} onClick={insertPending}>Insert transcript</button>}
        <button type="button" disabled={busy || state.phase === 'ready'}
          aria-label={recording ? 'Stop recording' : 'Record voice'}
          onClick={() => { if (recording) { active.current?.capture?.stop(); setState(s => ({ ...s, phase: 'uploading' })); } else void start(); }}
          style={{ ...micButton, background: recording ? 'var(--lloyal-voice-stop, #29292c)' : '#0a84ff', opacity: busy ? 0.5 : 1 }}>
          {recording ? <span aria-hidden="true" style={{ width: 13, height: 13, borderRadius: 3, background: '#ff453a' }} /> :
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M6 10v2a6 6 0 0 0 12 0v-2M12 18v3M9 21h6" /></svg>}
        </button>
      </div>
    </div>
    <RecordingWaveform levels={state.levels} elapsed={state.elapsed} recording={recording} status={labels[state.phase]} />
    {state.error && <div role="alert" style={{ fontSize: 12, marginTop: 8 }}>{state.error}</div>}
    {state.pending && <div style={{ fontSize: 13, marginTop: 8 }}>{state.pending.text}</div>}
  </div>;
}

const textButton: CSSProperties = { background: 'none', border: 0, color: 'inherit', font: 'inherit', fontSize: 12, cursor: 'pointer', padding: '6px 2px' };
const micButton: CSSProperties = { display: 'grid', placeItems: 'center', width: 42, height: 42, borderRadius: '50%', border: '1px solid rgba(255,255,255,.25)', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.12), 0 2px 8px rgba(0,0,0,.12)', color: '#fff', cursor: 'pointer', flex: '0 0 auto' };
