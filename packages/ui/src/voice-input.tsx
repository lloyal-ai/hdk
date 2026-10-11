import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ingestMedia } from '@lloyal-labs/media';
import type { VoiceCapabilities, VoiceCommand, VoiceEvent, VoiceResult } from '@lloyal-labs/binding';
import { useAvailability, useContentOrigin, useHarness } from './provider.js';
import { startAudioCapture } from './audio-capture.js';
import type { AudioCapture } from './audio-capture.js';

export type VoicePhase = 'idle' | 'requesting' | 'recording' | 'uploading' | 'transcribing' | 'ready' | 'error';
interface VoiceState { phase: VoicePhase; levels: number[]; elapsed: number; error?: string; pending?: VoiceResult }
const INITIAL: VoiceState = { phase: 'idle', levels: [], elapsed: 0 };
const ACTIVE: readonly VoicePhase[] = ['requesting', 'recording', 'uploading', 'transcribing'];

export interface VoiceInputOptions {
  /** Bundler-resolved asset URL, for example `@lloyal-labs/ui/pcm-worklet?url&no-inline` in Vite. */
  workletUrl: string;
  draft: string;
  onDraft(text: string): void;
  /** Current cursor range; otherwise dictation appends to the draft. */
  selection?(): { start: number; end: number };
  /** Changing the destination cancels dictation, for example navigation to another document. */
  destination?: string | null;
  /** Suspend dictation while the containing composer cannot accept edits. */
  disabled?: boolean;
}

/** Dictation as the composer sees it: one state, the actions on it, and nothing about layout. */
export interface VoiceInput {
  /** Whether the harness offers transcription; undefined until the host has answered, so a composer can
   *  keep the mic's place from first paint and only switch it on. */
  enabled?: boolean;
  /** The harness offers transcription and the composer can accept edits right now. */
  available: boolean;
  phase: VoicePhase;
  /** Capture holds the microphone or a request is in flight; the composer gives the row to it. */
  active: boolean;
  /** Normalized input levels, oldest first. */
  levels: readonly number[];
  elapsed: number;
  /** One sentence for the person; the next start or cancel clears it. */
  error?: string;
  /** A transcript that arrived after the draft changed, waiting for an explicit insert. */
  pending?: VoiceResult;
  start(): void;
  stop(): void;
  cancel(): void;
  insertPending(): void;
}

export function insertTranscript(draft: string, text: string, range: { start: number; end: number }): string {
  const start = Math.max(0, Math.min(draft.length, range.start));
  const end = Math.max(start, Math.min(draft.length, range.end));
  const before = draft.slice(0, start); const after = draft.slice(end);
  return before + (before && !/\s$/.test(before) ? ' ' : '') + text + (after && !/^\s/.test(after) ? ' ' : '') + after;
}

/** Capture and request state belongs to this draft; the only successful action is an editable text change. */
export function useVoiceInput({ workletUrl, draft, onDraft, selection, destination, disabled = false }: VoiceInputOptions): VoiceInput {
  const { bridge } = useHarness<VoiceEvent, VoiceCommand>();
  const origin = useContentOrigin();
  const availability = useAvailability();
  const [capabilities, setCapabilities] = useState<VoiceCapabilities | null>(null);
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
    setCapabilities(null);
    if (availability !== 'ready' || origin === null || disabled) return;
    const unsubscribe = bridge.onEvent(({ ev }) => {
      if (ev.type === 'voice:capabilities') { setCapabilities(ev.capabilities); return; }
      const current = active.current;
      if (!current || !('requestId' in ev) || ev.requestId !== current.id || current.controller.signal.aborted) return;
      if (ev.type === 'voice:progress') setState(s => ({ ...s, phase: 'transcribing' }));
      if (ev.type === 'voice:cancelled') { active.current = null; current.controller.abort(); setState(INITIAL); }
      if (ev.type === 'voice:error') { active.current = null; current.controller.abort(); setState({ ...INITIAL, phase: 'error', error: ev.message }); }
      if (ev.type === 'voice:result') {
        active.current = null;
        current.controller.abort();
        if (!ev.result.text) { setState({ ...INITIAL, phase: 'error', error: ev.result.silent ? 'The recording was silent.' : 'No transcript was returned.' }); return; }
        if (latest.current.revision === current.revision) {
          latest.current.onDraft(insertTranscript(current.draft, ev.result.text, current.range));
          setState(INITIAL);
        } else {
          setState({ ...INITIAL, phase: 'ready', pending: ev.result });
        }
      }
    });
    bridge.send({ type: 'voice:describe' });
    return () => {
      unsubscribe();
      const current = active.current; active.current = null;
      if (current) {
        current.controller.abort();
        if (latest.current.availability === 'ready') bridge.send({ type: 'voice:cancel', requestId: current.id });
      }
    };
  }, [bridge, availability, origin, destination, disabled]);

  const available = capabilities?.enabled === true && origin !== null && availability === 'ready' && !disabled;

  const start = async (): Promise<void> => {
    if (!capabilities?.enabled || origin === null || active.current || disabled) return;
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
        workletUrl,
        signal: current.controller.signal, limits: capabilities.limits,
        // About twenty seconds of history at the worklet's flush rate: enough for the widest row to show real levels.
        onLevel: (level, elapsed) => { if (owns()) setState(s => ({ ...s, levels: [...s.levels.slice(-479), Math.min(1, Math.sqrt(level))], elapsed })); },
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
      setState({ ...INITIAL, phase: 'error', error: error instanceof Error ? error.message : 'Recording failed.' });
    }
  };

  const stop = (): void => {
    if (state.phase !== 'recording') return;
    active.current?.capture?.stop();
    setState(s => ({ ...s, phase: 'uploading' }));
  };

  const insertPending = (): void => {
    if (!state.pending) return;
    const { draft: text, selection: range, onDraft: change } = latest.current;
    change(insertTranscript(text, state.pending.text, range?.() ?? { start: text.length, end: text.length }));
    setState(INITIAL);
  };

  return {
    enabled: capabilities?.enabled, available, phase: state.phase, active: ACTIVE.includes(state.phase),
    levels: state.levels, elapsed: state.elapsed, error: state.error, pending: state.pending,
    start: () => { void start(); }, stop, cancel, insertPending,
  };
}

/** The microphone, drawn in the current color so it sits with a composer's other icons. */
export function MicGlyph({ size = 18 }: { size?: number }): ReactElement {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="3" width="6" height="12" rx="3" />
    <path d="M6 10v2a6 6 0 0 0 12 0v-2M12 18v3M9 21h6" />
  </svg>;
}
