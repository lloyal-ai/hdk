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
  it('stops a permission grant that arrives after cancellation', async () => {
    let grant!: (stream: MediaStream) => void;
    const stop = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise<MediaStream>(r => { grant = r; }) } });
    const controller = new AbortController();
    const pending = capture.startAudioCapture({ signal: controller.signal, onLevel: () => {} });
    controller.abort();
    grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await expect(pending).rejects.toThrow();
    expect(stop).toHaveBeenCalledOnce();
  });
});
