/**
 * Reading a clip through any decoder: the page's procedure, written once
 * against the decoder contract, gives the same frames, windows and length
 * whichever decoder reads the file.
 */
import { describe, expect, it } from 'vitest';
import { MANIFEST_TYPE } from '../src/attachment';
import { prepareVideo, sampleFrames, soundtrackWindows } from '../src/clip';
import type { ClipDecoder, DecodedSound } from '../src/clip';

const SAMPLING = { fps: 4, timestampIntervalMs: 5000, maxFrames: 64, maxEdgePx: 640 };

/** A made-up clip: a 1280×720 picture starting at `startS` whose frames change every `frameS`, and the sound given. */
function madeUp(clip: { endS?: number; startS?: number; frameS?: number; sound?: DecodedSound[] } = {}) {
  const { endS = 2, startS = 0, frameS = 0.125, sound = [] } = clip;
  const asked: { times: number[]; size: { width: number; height: number } }[] = [];
  const decoder: ClipDecoder & { asked: typeof asked; disposed: number } = {
    asked,
    disposed: 0,
    async duration() { return endS; },
    async picture() { return { width: 1280, height: 720, startS }; },
    async *frames(times, size) {
      asked.push({ times, size });
      for (const t of times) {
        const shownS = Math.floor(t / frameS) * frameS;
        yield { shownS, bytes: new Uint8Array([0xff, 0xd8, 0xff, Math.round(shownS * 1000) % 256]) };
      }
    },
    async *sound() { yield* sound; },
    dispose() { decoder.disposed++; },
  };
  return decoder;
}

/** One constant level, `seconds` long at `rate`, presented at `atS`, on `channels` channels. */
const tone = (atS: number, seconds: number, rate: number, level = 0.5, channels = 1): DecodedSound => ({
  shownS: atS, sampleRate: rate, channels: Array.from({ length: channels }, () => new Float32Array(Math.round(seconds * rate)).fill(level)),
});

describe('sampleFrames, through any decoder', () => {
  it('asks for the policy\'s times at the policy\'s edge, and stamps each frame with the time the decoder showed it', async () => {
    const decoder = madeUp();
    const { frames, durationMs } = await sampleFrames(decoder, SAMPLING);
    expect(decoder.asked[0].size).toEqual({ width: 640, height: 360 });
    expect(decoder.asked[0].times).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75]);
    expect(frames.map(f => f.tMs)).toEqual([0, 250, 500, 750, 1000, 1250, 1500, 1750]);
    expect(durationMs).toBe(2000);
  });

  it('keeps a frame once when the decoder shows it for several sample times', async () => {
    const { frames } = await sampleFrames(madeUp({ frameS: 0.5 }), SAMPLING);
    expect(frames.map(f => f.tMs)).toEqual([0, 500, 1000, 1500]);
  });

  it('samples from the picture\'s first frame, and from zero when the picture starts before it', async () => {
    const late = madeUp({ startS: 0.5 });
    await sampleFrames(late, SAMPLING);
    expect(late.asked[0].times[0]).toBe(0.5);
    const early = madeUp({ startS: -0.04 });
    const { frames } = await sampleFrames(early, SAMPLING);
    expect(early.asked[0].times[0]).toBe(0);
    expect(frames[0].tMs).toBe(0);
  });

  it('stops the decoder when it is aborted, and says it was aborted', async () => {
    const decoder = madeUp();
    const abort = new AbortController();
    abort.abort();
    await expect(sampleFrames(decoder, SAMPLING, { signal: abort.signal })).rejects.toThrow(/abort/i);
  });
});

describe('soundtrackWindows, through any decoder', () => {
  async function heard(decoder: ClipDecoder, maxSampleRate?: number) {
    const windows = [];
    for await (const w of soundtrackWindows(decoder, 1000, { ...(maxSampleRate ? { maxSampleRate } : {}) })) windows.push(w);
    return windows;
  }
  const rateOf = (wav: Uint8Array) => new DataView(wav.buffer, wav.byteOffset).getUint32(24, true);

  it('mixes the channels to mono, at the rate the service admits, and ends on the clip\'s clock', async () => {
    const windows = await heard(madeUp({ endS: 1.5, sound: [tone(0, 2, 48_000, 0.5, 2)] }), 16_000);
    expect(windows.every(w => rateOf(w.bytes) === 16_000)).toBe(true);
    expect(windows.at(-1)!.endMs).toBe(1500);
    windows.forEach((w, i) => { if (i > 0) expect(w.startMs).toBe(windows[i - 1].endMs); });
  });

  it('places sound that starts late at its own time, the gap silent', async () => {
    const windows = await heard(madeUp({ endS: 2, sound: [tone(1, 1, 1000)] }));
    const pcm = windows.flatMap(w => [...new Int16Array(w.bytes.slice(44).buffer)]);
    expect(pcm.length).toBe(2000);
    expect(pcm[500]).toBe(0);
    expect(pcm[1500]).toBeGreaterThan(0);
  });

  it('yields nothing for a clip with no sound', async () => {
    expect(await heard(madeUp())).toEqual([]);
  });
});

describe('prepareVideo, the page\'s assembly through any decoder', () => {
  const ingested: Uint8Array[] = [];
  const ingest = async (bytes: Uint8Array) => {
    ingested.push(bytes);
    return { mediaType: MANIFEST_TYPE, digest: `sha256:${String(ingested.length).padStart(64, '0')}`, size: bytes.byteLength };
  };
  const limits = { maxBytes: 16 * 1024 * 1024, maxDurationSeconds: 60, maxSampleRate: 16_000 };

  it('ingests every frame and soundtrack window, and gives the compose its references and length', async () => {
    ingested.length = 0;
    const phases: string[] = [];
    const prepared = await prepareVideo(madeUp({ endS: 12, sound: [tone(0, 12, 16_000)] }), { sampling: SAMPLING, soundtrack: limits }, ingest, {
      onProgress: p => phases.push(p.phase),
    });
    expect(prepared.frames).toHaveLength(48);
    expect(prepared.audio.length).toBeGreaterThan(1);
    expect(ingested).toHaveLength(prepared.frames.length + prepared.audio.length);
    expect(prepared.audio.at(-1)!.endMs).toBe(12_000);
    expect(prepared.durationMs).toBe(12_000);
    expect(new Set(phases)).toEqual(new Set(['sampling', 'ingesting']));
  });

  it('cuts no soundtrack when nothing the host runs hears', async () => {
    const prepared = await prepareVideo(madeUp({ sound: [tone(0, 2, 16_000)] }), { sampling: SAMPLING, soundtrack: null }, ingest);
    expect(prepared.audio).toEqual([]);
  });

  it('cuts the soundtrack at the mark interval its sparse frames are recorded with', async () => {
    // 60 s at the policy's cap of 4 frames: frames 15 s apart, so marks every 30 s and windows sized to match.
    const prepared = await prepareVideo(
      madeUp({ endS: 60, frameS: 0.5, sound: [tone(0, 60, 16_000)] }),
      { sampling: { ...SAMPLING, maxFrames: 4 }, soundtrack: { ...limits, maxDurationSeconds: 120 } }, ingest,
    );
    // A window the cutter may end up to a fifth either side of its nominal 30 s, never near the 5 s default.
    expect(prepared.audio[0].endMs - prepared.audio[0].startMs).toBeGreaterThanOrEqual(30_000 * 4 / 5);
  });
});
