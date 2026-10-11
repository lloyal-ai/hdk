// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Bridge, Frame, VoiceCommand, VoiceEvent, VoiceResult, WireStatus } from '@lloyal-labs/binding';
import { DEFAULT_AUDIO_ADMISSION, ingestMedia, MANIFEST_TYPE } from '@lloyal-labs/media';
import { HarnessProvider } from '../src/provider';
import { useVoiceInput } from '../src/voice-input';
import type { VoiceInputOptions } from '../src/voice-input';
import { RecordingWaveform } from '../src/recording-waveform';
import { startAudioCapture } from '../src/audio-capture';

vi.mock('../src/audio-capture', () => ({ startAudioCapture: vi.fn() }));
vi.mock('@lloyal-labs/media', async (original) => ({ ...await original<object>(), ingestMedia: vi.fn() }));

const audio = { mediaType: MANIFEST_TYPE, digest: `sha256:${'a'.repeat(64)}`, size: 120 };
const result = { text: 'spoken words', audio, silent: false } as VoiceResult;
const capabilities = { enabled: true as const, model: 'Qwen3 ASR', limits: DEFAULT_AUDIO_ADMISSION };

/** The smallest composer: one row that gives the hook's state the same controls a real one does. */
function Composer(options: VoiceInputOptions) {
  const voice = useVoiceInput(options);
  return createElement('div', null,
    voice.available && createElement('button', {
      'aria-label': voice.phase === 'recording' ? 'Stop recording' : 'Record voice',
      disabled: voice.active && voice.phase !== 'recording',
      onClick: () => (voice.phase === 'recording' ? voice.stop() : voice.start()),
    }),
    voice.active && createElement('button', { 'aria-label': 'Cancel dictation', onClick: voice.cancel }),
    voice.pending && createElement('button', { onClick: voice.insertPending }, 'Insert transcript'),
    voice.active && createElement(RecordingWaveform, { levels: voice.levels, elapsed: voice.elapsed, recording: voice.phase === 'recording' }),
    voice.error && createElement('span', { role: 'alert' }, voice.error),
  );
}

function voiceBridge() {
  const events = new Set<(frame: Frame<VoiceEvent>) => void>();
  const statuses = new Set<(status: WireStatus) => void>();
  const sent: VoiceCommand[] = [];
  const push = (ev: VoiceEvent): void => events.forEach(cb => cb({ epoch: 1, seq: 1, ev }));
  const bridge: Bridge<VoiceEvent, VoiceCommand, object> = {
    onEvent(cb) { events.add(cb); return () => { events.delete(cb); }; },
    onStatus(cb) { statuses.add(cb); cb('connected'); return () => { statuses.delete(cb); }; },
    send(command) { sent.push(command); if (command.type === 'voice:describe') push({ type: 'voice:capabilities', capabilities }); },
    requestSnapshot: async () => ({ state: {}, epoch: 1, seq: 0 }),
    contentOrigin: () => '',
  };
  return { bridge, sent, push, status: (value: WireStatus) => statuses.forEach(cb => cb(value)) };
}

describe('dictation in an editable draft', () => {
  let root: Root;
  let container: HTMLDivElement;
  let captureSignal: AbortSignal;
  let finish: (bytes: Uint8Array) => void;
  const changed = vi.fn();
  beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
  afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.clearAllMocks(); });

  async function setup() {
    const transport = voiceBridge();
    vi.mocked(ingestMedia).mockResolvedValue(audio);
    vi.mocked(startAudioCapture).mockImplementation(async ({ signal, onLevel }) => {
      captureSignal = signal;
      const result = new Promise<Uint8Array>(resolve => { finish = resolve; });
      onLevel(0.5, 4);
      return { result, stop: () => finish(new Uint8Array([1, 2, 3])) };
    });
    container = document.createElement('div'); document.body.appendChild(container);
    root = createRoot(container);
    const render = async (draft: string, destination = 'one') => {
      await act(async () => root.render(createElement(HarnessProvider, {
        bridge: transport.bridge, initialState: {}, reduce: s => s,
        children: createElement(Composer, { workletUrl: '/assets/pcm-worklet.js', draft, onDraft: changed, destination }),
      })));
    };
    await render('Existing');
    return { ...transport, render };
  }

  const button = (label: string): HTMLButtonElement | undefined =>
    [...container.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label || b.textContent === label);

  async function click(label: string): Promise<void> {
    const target = button(label);
    expect(target, label).toBeDefined();
    await act(async () => target!.click());
  }

  it('shows actual capture levels and inserts the transcript without submitting the draft', async () => {
    const { sent, push } = await setup();
    await click('Record voice');
    expect(startAudioCapture).toHaveBeenCalledWith(expect.objectContaining({ workletUrl: '/assets/pcm-worklet.js' }));
    expect(container.textContent).toContain('00:04');
    expect(container.querySelector('.lloyal-wave-live rect[opacity="0.9"]')).not.toBeNull();
    await click('Stop recording');
    expect(button('Record voice')?.disabled).toBe(true);
    const request = sent.find(c => c.type === 'voice:transcribe')!;
    expect(request).toMatchObject({ audio });
    await act(async () => push({ type: 'voice:result', requestId: request.requestId, result }));
    expect(changed).toHaveBeenCalledExactlyOnceWith('Existing spoken words');
    expect(button('Record voice')?.disabled).toBe(false);
    expect(container.querySelector('.lloyal-wave-live')).toBeNull();
    expect(sent.every(c => c.type.startsWith('voice:'))).toBe(true);
  });

  it('preserves newer edits and inserts only when the reader chooses', async () => {
    const { sent, push, render } = await setup();
    await click('Record voice'); await click('Stop recording');
    const request = sent.find(c => c.type === 'voice:transcribe')!;
    await render('Edited while waiting');
    await act(async () => push({ type: 'voice:result', requestId: request.requestId, result }));
    expect(changed).not.toHaveBeenCalled();
    await click('Insert transcript');
    expect(changed).toHaveBeenCalledExactlyOnceWith('Edited while waiting spoken words');
  });

  it('cancels capture when its destination changes and starts the new destination idle', async () => {
    const { render } = await setup();
    await click('Record voice');
    await render('Another draft', 'two');
    expect(captureSignal.aborted).toBe(true);
    expect(button('Record voice')?.disabled).toBe(false);
    expect(container.querySelector('.lloyal-wave-live')).toBeNull();
  });

  it('cancels from the row, telling the host, and leaves the draft untouched', async () => {
    const { sent } = await setup();
    await click('Record voice'); await click('Stop recording');
    const request = sent.find(c => c.type === 'voice:transcribe')!;
    await click('Cancel dictation');
    expect(captureSignal.aborted).toBe(true);
    expect(sent.at(-1)).toEqual({ type: 'voice:cancel', requestId: request.requestId });
    expect(changed).not.toHaveBeenCalled();
    expect(button('Record voice')?.disabled).toBe(false);
  });

  it('turns a silent recording into one quiet sentence that the next attempt clears', async () => {
    const { sent, push } = await setup();
    await click('Record voice'); await click('Stop recording');
    const request = sent.find(c => c.type === 'voice:transcribe')!;
    await act(async () => push({ type: 'voice:result', requestId: request.requestId, result: { ...result, text: '', silent: true } }));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('The recording was silent.');
    expect(changed).not.toHaveBeenCalled();
    await click('Record voice');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('aborts on connection loss without sending to the lost connection or accepting an obsolete result', async () => {
    const { sent, push, status } = await setup();
    await click('Record voice'); await click('Stop recording');
    const request = sent.find(c => c.type === 'voice:transcribe')!;
    const sentBeforeLoss = sent.length;
    await act(async () => status('lost'));
    expect(captureSignal.aborted).toBe(true);
    expect(sent).toHaveLength(sentBeforeLoss);
    await act(async () => { status('connected'); });
    await act(async () => push({ type: 'voice:result', requestId: request.requestId, result }));
    expect(changed).not.toHaveBeenCalled();
    expect(button('Record voice')?.disabled).toBe(false);
  });
});
