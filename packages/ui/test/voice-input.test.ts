// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Bridge, Frame, VoiceCommand, VoiceEvent, VoiceResult, WireStatus } from '@lloyal-labs/binding';
import { DEFAULT_AUDIO_ADMISSION, ingestMedia, MANIFEST_TYPE } from '@lloyal-labs/media';
import { HarnessProvider } from '../src/provider';
import { VoiceInput } from '../src/voice-input';
import { startAudioCapture } from '../src/audio-capture';

vi.mock('../src/audio-capture', () => ({ startAudioCapture: vi.fn() }));
vi.mock('@lloyal-labs/media', async (original) => ({ ...await original<object>(), ingestMedia: vi.fn() }));

const audio = { mediaType: MANIFEST_TYPE, digest: `sha256:${'a'.repeat(64)}`, size: 120 };
const result = { text: 'spoken words', audio, silent: false } as VoiceResult;
const capabilities = { enabled: true as const, model: 'Qwen3 ASR', limits: DEFAULT_AUDIO_ADMISSION };

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
        children: createElement(VoiceInput, { draft, onDraft: changed, destination }),
      })));
    };
    await render('Existing');
    return { ...transport, render };
  }

  async function click(label: string): Promise<void> {
    const button = [...container.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label || b.textContent === label);
    expect(button, label).toBeDefined();
    await act(async () => button!.click());
  }

  it('shows actual capture levels and inserts the transcript without submitting the draft', async () => {
    const { sent, push } = await setup();
    await click('Record voice');
    expect(container.textContent).toContain('00:04');
    expect(container.querySelector('.lloyal-wave-live rect[opacity="0.9"]')).not.toBeNull();
    await click('Stop recording');
    const request = sent.find(c => c.type === 'voice:transcribe')!;
    expect(request).toMatchObject({ audio });
    await act(async () => push({ type: 'voice:result', requestId: request.requestId, result }));
    expect(changed).toHaveBeenCalledExactlyOnceWith('Existing spoken words');
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
    expect(container.querySelector('[aria-label="Record voice"]')).not.toBeNull();
    expect(container.textContent).toContain('00:00');
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
    expect(container.querySelector('[aria-label="Record voice"]')?.hasAttribute('disabled')).toBe(false);
  });
});
