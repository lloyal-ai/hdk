import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectPcmWav } from '@lloyal-labs/media';
import * as capture from '../src/audio-capture';

afterEach(() => vi.unstubAllGlobals());
describe('microphone capture', () => {
  it('encodes mono PCM16 at its actual rate and bounds allocation before assembling WAV', () => {
    const bytes = capture.encodePcmWav([new Int16Array([1000, -1000, 0])], 48000, 100);
    expect(inspectPcmWav(bytes)).toMatchObject({ sampleRate: 48000, channels: 1, frames: 3, bitsPerSample: 16, silent: false });
    expect(() => capture.encodePcmWav([new Int16Array(100)], 48000, 100)).toThrow(/limit/);
  });
  it('turns the browser\'s refusal codes into one sentence a person can act on', async () => {
    const refusal = (name: string) => Object.assign(new Error('Permission denied'), { name });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => Promise.reject(refusal('NotAllowedError')) } });
    await expect(capture.startAudioCapture({ workletUrl: '/w.js', signal: new AbortController().signal, onLevel: () => {} }))
      .rejects.toThrow('Microphone access was refused. Allow it for this app, then try again.');
    expect(capture.explainDenial(refusal('NotFoundError'))).toBe('No microphone was found.');
    expect(capture.explainDenial(refusal('NotReadableError'))).toBe('The microphone is in use by another app.');
    expect(capture.explainDenial(new Error('something else'))).toBe('something else');
  });
  it('stops a permission grant that arrives after cancellation', async () => {
    let grant!: (stream: MediaStream) => void;
    const stop = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise<MediaStream>(r => { grant = r; }) } });
    const controller = new AbortController();
    const pending = capture.startAudioCapture({ workletUrl: '/assets/pcm-worklet.js', signal: controller.signal, onLevel: () => {} });
    controller.abort();
    grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await expect(pending).rejects.toThrow();
    expect(stop).toHaveBeenCalledOnce();
  });
});
