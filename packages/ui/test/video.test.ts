/**
 * Attaching a video from the page: what is sampled, how the soundtrack is cut,
 * and the order of the conversation with the host — the original pushed, every
 * frame and window ingested, then one compose that resolves to the root.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Frame, VideoCommand, VideoEvent } from '@lloyal-labs/binding';
import { MANIFEST_TYPE, ingestMedia, pushBlob } from '@lloyal-labs/media';
import { SoundtrackCutter, fitEdge, frameTimes, ingestVideo, pcm16Wav, quietestCut } from '../src/video';

vi.mock('@lloyal-labs/media', async (original) => ({ ...await original<object>(), ingestMedia: vi.fn(), pushBlob: vi.fn() }));

// Stand-in decoder: a 2-second, 320×240 clip whose frames are shown at 8 fps, and a silent-free soundtrack.
vi.mock('mediabunny', () => {
  class Input {
    dispose(): void {}
    async getPrimaryVideoTrack() {
      return { canDecode: async () => true, getFirstTimestamp: async () => 0, displayWidth: 320, displayHeight: 240 };
    }
    async getPrimaryAudioTrack() { return null; }
    async computeDuration() { return 2; }
  }
  class CanvasSink {
    async *canvasesAtTimestamps(times: number[]) {
      for (const t of times) {
        const shown = Math.floor(t * 8) / 8;
        yield { timestamp: shown, duration: 0.125, canvas: { convertToBlob: async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, Math.round(shown * 8)])]) } };
      }
    }
  }
  return { Input, CanvasSink, BlobSource: class {}, AudioBufferSink: class {}, ALL_FORMATS: [] };
});

const SAMPLING = { fps: 4, timestampIntervalMs: 5000, maxFrames: 64, maxEdgePx: 640 };

describe('what to sample', () => {
  it('samples at the rate, and spreads a clip too long for the frame cap', () => {
    expect(frameTimes(1, { fps: 4, maxFrames: 64 })).toEqual([0, 0.25, 0.5, 0.75]);
    const long = frameTimes(100, { fps: 4, maxFrames: 10 });
    expect(long).toHaveLength(10);
    expect(long[1]).toBeCloseTo(10);
  });

  it('fits the longest edge without upscaling', () => {
    expect(fitEdge(1920, 1080, 640)).toEqual({ width: 640, height: 360 });
    expect(fitEdge(320, 240, 640)).toEqual({ width: 320, height: 240 });
    expect(fitEdge(1080, 1920, 640)).toEqual({ width: 360, height: 640 });
  });
});

describe('cutting a soundtrack', () => {
  it('ends a window at the quietest point near its nominal end', () => {
    const rate = 1000;
    const loud = new Float32Array(2000).fill(0.5);
    loud.fill(0, 1040, 1060);
    expect(quietestCut(loud, rate, 1000, 200)).toBe(1060);
  });

  it('cuts windows with no overlaps and no gaps, and flushes the remainder', () => {
    const rate = 1000;
    const cutter = new SoundtrackCutter(rate, 1000);
    const windows = [...cutter.push(new Float32Array(1500).fill(0.1)), ...cutter.push(new Float32Array(1200).fill(0.1)), ...cutter.flush()];
    expect(windows[0].startMs).toBe(0);
    for (let i = 1; i < windows.length; i++) expect(windows[i].startMs).toBe(windows[i - 1].endMs);
    expect(windows.at(-1)!.endMs).toBe(2700);
  });

  it('encodes mono PCM16 WAV the transcription service admits', () => {
    const wav = pcm16Wav(new Float32Array([0, 1, -1]), 16000);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    const view = new DataView(wav.buffer);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getInt16(46, true)).toBe(32767);
  });
});

describe('ingestVideo', () => {
  it('pushes the original, ingests every frame, and resolves on the host\'s composed root', async () => {
    const root = { mediaType: MANIFEST_TYPE, digest: `sha256:${'c'.repeat(64)}`, size: 10 };
    vi.mocked(pushBlob).mockResolvedValue({ mediaType: 'video/mp4', digest: `sha256:${'d'.repeat(64)}`, size: 2518 });
    let n = 0;
    vi.mocked(ingestMedia).mockImplementation(async () => ({ mediaType: MANIFEST_TYPE, digest: `sha256:${String(n++).padStart(64, '0')}`, size: 1 }));
    const listeners: Array<(f: Frame<VideoEvent>) => void> = [];
    const sent: VideoCommand[] = [];
    const bridge = {
      onEvent: (cb: (f: Frame<VideoEvent>) => void) => { listeners.push(cb); return () => listeners.splice(listeners.indexOf(cb), 1); },
      send: (c: VideoCommand) => {
        sent.push(c);
        if (c.type === 'video:compose') {
          queueMicrotask(() => listeners.forEach(l => l({ ev: { type: 'video:composed', requestId: c.requestId, root: root as never, untranscribed: [] } } as unknown as Frame<VideoEvent>)));
        }
      },
    };
    const progress: string[] = [];
    const attached = await ingestVideo({
      origin: '', bridge, file: new Blob([new Uint8Array(10)], { type: 'video/mp4' }),
      capabilities: { sampling: SAMPLING, transcription: false }, onProgress: (p) => progress.push(p.phase),
    });
    expect(attached.root).toEqual(root);
    const compose = sent.find(c => c.type === 'video:compose') as Extract<VideoCommand, { type: 'video:compose' }>;
    expect(compose.frames.map(f => f.tMs)).toEqual([0, 250, 500, 750, 1000, 1250, 1500, 1750]);
    expect(compose.source?.digest).toBe(`sha256:${'d'.repeat(64)}`);
    expect(compose.audio).toBeUndefined();
    expect(compose.durationMs).toBe(2000);
    expect(new Set(progress)).toEqual(new Set(['sampling', 'ingesting', 'composing']));
  });
});

describe('ingestVideo before the host has described video', () => {
  it('asks the host how it composes a video, and goes on with the answer', async () => {
    vi.mocked(pushBlob).mockResolvedValue({ mediaType: 'video/mp4', digest: `sha256:${'d'.repeat(64)}`, size: 2518 });
    vi.mocked(ingestMedia).mockImplementation(async () => ({ mediaType: MANIFEST_TYPE, digest: `sha256:${'e'.repeat(64)}`, size: 1 }));
    const listeners: Array<(f: Frame<VideoEvent>) => void> = [];
    const sent: string[] = [];
    const emit = (ev: VideoEvent): void => { queueMicrotask(() => [...listeners].forEach(l => l({ ev } as unknown as Frame<VideoEvent>))); };
    const bridge = {
      onEvent: (cb: (f: Frame<VideoEvent>) => void) => { listeners.push(cb); return () => { listeners.splice(listeners.indexOf(cb), 1); }; },
      send: (c: VideoCommand) => {
        sent.push(c.type);
        if (c.type === 'video:describe') emit({ type: 'video:capabilities', capabilities: { sampling: SAMPLING, transcription: false } });
        if (c.type === 'video:compose') emit({ type: 'video:composed', requestId: c.requestId, root: { mediaType: MANIFEST_TYPE, digest: `sha256:${'f'.repeat(64)}`, size: 1 } as never, untranscribed: [] });
      },
    };
    const attached = await ingestVideo({ origin: '', bridge, file: new Blob([new Uint8Array(10)]), capabilities: null });
    expect(sent).toEqual(['video:describe', 'video:compose']);
    expect(attached.root.digest).toBe(`sha256:${'f'.repeat(64)}`);
  });
});
