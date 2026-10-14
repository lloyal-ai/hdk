/**
 * Reading a video in the page: what is sampled, how frames are sized, and how
 * a soundtrack is cut into windows the transcription service admits.
 */
import { describe, expect, it, vi } from 'vitest';
import { SoundtrackCutter, fitEdge, frameTimes, pcm16Wav, quietestCut, sampleVideo } from '../src/video-sampling';

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
});
