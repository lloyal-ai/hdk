/**
 * Reading a video in the page: what is sampled, how frames are sized, and how
 * a soundtrack is cut into windows the transcription service admits.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoundtrackCutter, captureFrames, extractAudioWindows, fitEdge, frameTimes, pcm16Wav, quietestCut, sampleVideo } from '../src/video-sampling';
import type { SampledFrame, SoundtrackWindow } from '../src/video-sampling';

// Stand-in decoder: a 2-second, 320×240 clip whose frames are shown at 8 fps. A test sets the soundtrack:
// `globalThis.soundtrack`, decoded buffers with their timestamps, and `globalThis.videoStart`; `globalThis.onDecode`
// sees each frame decoded.
vi.mock('mediabunny', () => {
  class Input {
    dispose(): void {}
    async getPrimaryVideoTrack() {
      const start = (globalThis as { videoStart?: number }).videoStart ?? 0;
      return { canDecode: async () => true, getFirstTimestamp: async () => start, displayWidth: 320, displayHeight: 240 };
    }
    async getPrimaryAudioTrack() {
      const buffers = (globalThis as { soundtrack?: unknown[] }).soundtrack;
      return buffers ? { canDecode: async () => true, getFirstTimestamp: async () => 0, buffers } : null;
    }
    async computeDuration() { return 2; }
  }
  class CanvasSink {
    async *canvasesAtTimestamps(times: number[]) {
      for (const t of times) {
        (globalThis as { onDecode?: () => void }).onDecode?.();
        const shown = Math.floor(t * 8) / 8;
        yield { timestamp: shown, duration: 0.125, canvas: { convertToBlob: async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, Math.round(shown * 8)])]) } };
      }
    }
  }
  class AudioBufferSink {
    constructor(private readonly track: { buffers: unknown[] }) {}
    async *buffers() { yield* this.track.buffers; }
  }
  return { Input, CanvasSink, BlobSource: class {}, AudioBufferSink, ALL_FORMATS: [] };
});

const SAMPLING = { fps: 4, timestampIntervalMs: 5000, maxFrames: 64, maxEdgePx: 640 };

describe('what to sample', () => {
  it('samples at the rate, and spreads a clip too long for the frame cap', () => {
    expect(frameTimes(1, { fps: 4, maxFrames: 64 })).toEqual([0, 0.25, 0.5, 0.75]);
    // Every sample instant inside the clip, the last partial interval included.
    expect(frameTimes(0.26, { fps: 4, maxFrames: 64 })).toEqual([0, 0.25]);
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

describe('sampleVideo', () => {
  it('samples at the rate, stamps each frame with the time it was shown, and keeps a repeated frame once', async () => {
    const { frames, durationMs } = await sampleVideo(new Blob([new Uint8Array(10)]), SAMPLING);
    expect(durationMs).toBe(2000);
    expect(frames.map(f => f.tMs)).toEqual([0, 250, 500, 750, 1000, 1250, 1500, 1750]);
    expect(frames[0].bytes.subarray(0, 3)).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
  });

  it('keeps a frame once when a sparse source shows it at several sample times', async () => {
    const { frames } = await sampleVideo(new Blob([new Uint8Array(10)]), { ...SAMPLING, fps: 16 });
    expect(frames.map(f => f.tMs)).toEqual([0, 125, 250, 375, 500, 625, 750, 875, 1000, 1125, 1250, 1375, 1500, 1625, 1750, 1875]);
  });

  it('stops decoding as soon as it is aborted', async () => {
    const abort = new AbortController();
    let decoded = 0;
    (globalThis as { onDecode?: () => void }).onDecode = () => { if (++decoded === 2) abort.abort(); };
    try {
      await expect(sampleVideo(new Blob([new Uint8Array(10)]), SAMPLING, { signal: abort.signal })).rejects.toThrow(/abort/i);
      expect(decoded).toBe(2);
    } finally {
      delete (globalThis as { onDecode?: () => void }).onDecode;
    }
  });
});

describe('extractAudioWindows', () => {
  const RATE = 1000;
  /** A decoded buffer of one constant level, `seconds` long, presented at `timestamp`. */
  const sound = (timestamp: number, seconds: number, level = 0.5) => {
    const samples = new Float32Array(Math.round(seconds * RATE)).fill(level);
    return { timestamp, buffer: { sampleRate: RATE, numberOfChannels: 1, length: samples.length, getChannelData: () => samples } };
  };
  /** The windows joined back into one track of samples on the clip's clock. */
  async function heard(): Promise<Float32Array> {
    const windows: SoundtrackWindow[] = [];
    for await (const w of extractAudioWindows(new Blob([new Uint8Array(1)]), 1000)) windows.push(w);
    windows.forEach((w, i) => { if (i > 0) expect(w.startMs).toBe(windows[i - 1].endMs); });
    const pcm = windows.flatMap((w) => [...new Int16Array(w.bytes.slice(44).buffer)]);
    return Float32Array.from(pcm, (v) => v / 32767);
  }
  const g = globalThis as { soundtrack?: unknown[]; videoStart?: number };
  afterEach(() => { delete g.soundtrack; delete g.videoStart; });

  it('stops decoding the soundtrack as soon as it is aborted', async () => {
    const abort = new AbortController();
    let decoded = 0;
    // A track whose second buffer arrives after the abort: nothing past it is decoded.
    g.soundtrack = { *[Symbol.iterator]() { decoded++; yield sound(0, 1); abort.abort(); decoded++; yield sound(1, 1); decoded++; yield sound(2, 1); } } as unknown as unknown[];
    const windows: SoundtrackWindow[] = [];
    await expect((async () => {
      for await (const w of extractAudioWindows(new Blob([new Uint8Array(1)]), 1000, { signal: abort.signal })) windows.push(w);
    })()).rejects.toThrow(/abort/i);
    expect(decoded).toBe(2);
  });

  it('places sound that starts late, or pauses, at its own time on the clip, the gaps silent', async () => {
    g.soundtrack = [sound(1, 1), sound(3, 1)];
    const track = await heard();
    expect(track.length).toBe(4 * RATE);
    expect(track[500]).toBe(0);
    expect(track[1500]).toBeCloseTo(0.5, 2);
    expect(track[2500]).toBe(0);
    expect(track[3500]).toBeCloseTo(0.5, 2);
  });

  it('leaves out sound before the first frame, so a window starts where the picture does', async () => {
    g.videoStart = 0.5;
    g.soundtrack = [sound(0, 0.5, 0.9), sound(0.5, 1, 0.3)];
    const track = await heard();
    expect(track.length).toBe(RATE);
    expect(track[0]).toBeCloseTo(0.3, 2);
  });
});

describe('captureFrames', () => {
  /** A live track whose frames arrive at these times (ms), through the processor Chromium provides; one that
   *  stalls delivers nothing after them, as a paused camera does. */
  function liveTrack(arrivals: number[], { stalls = false } = {}) {
    const frames = arrivals.map((ms) => ({ timestamp: ms * 1000, displayWidth: 64, displayHeight: 48, close: () => {} }));
    (globalThis as Record<string, unknown>).MediaStreamTrackProcessor = class {
      readable = new ReadableStream({ start(c) { frames.forEach((f) => c.enqueue(f)); if (!stalls) c.close(); } });
    };
    (globalThis as Record<string, unknown>).OffscreenCanvas = class {
      getContext() { return { drawImage: () => {} }; }
      async convertToBlob() { return new Blob([new Uint8Array([0xff, 0xd8, 0xff])]); }
    };
    return {} as MediaStreamTrack;
  }
  afterEach(() => { delete (globalThis as Record<string, unknown>).MediaStreamTrackProcessor; delete (globalThis as Record<string, unknown>).OffscreenCanvas; });

  it('samples at the rate, and a late frame does not let a burst through behind it', async () => {
    const taken: number[] = [];
    for await (const group of captureFrames(liveTrack([0, 100, 250, 1000, 1001, 1002, 1003, 1250]), { fps: 4, groupSize: 100, maxEdgePx: 640 })) {
      taken.push(...group.map((f) => f.tMs));
    }
    expect(taken).toEqual([0, 250, 1000, 1250]);
  });

  it('stops on abort while waiting for a frame that never comes', async () => {
    const abort = new AbortController();
    const groups = captureFrames(liveTrack([0], { stalls: true }), { fps: 4, groupSize: 2, maxEdgePx: 640, signal: abort.signal });
    const pending = groups.next();
    setTimeout(() => abort.abort(), 10);
    expect((await pending).value?.map((f: SampledFrame) => f.tMs)).toEqual([0]);
    expect((await groups.next()).done).toBe(true);
  });
});
