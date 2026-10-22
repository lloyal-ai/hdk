/**
 * Attaching a video from the page: the order of the conversation with the
 * host — the original pushed, every frame and window ingested, then one
 * compose that resolves to the root.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Frame, VideoCommand, VideoEvent } from '@lloyal-labs/binding';
import { MANIFEST_TYPE, ingestMedia, pushBlob } from '@lloyal-labs/media';
import { mediabunnyDecoder, videoDurationMs } from '@lloyal-labs/media/client';
import { ingestVideo } from '../src/video';

vi.mock('@lloyal-labs/media', async (original) => ({ ...await original<object>(), ingestMedia: vi.fn(), pushBlob: vi.fn() }));
// The page's decoder over a made-up clip: `clip.seconds` long, a 1280×720 picture whose frames change 8 times a
// second, and, when `clip.sound` is set, that many seconds of sound at `clip.rate`. `clip.sizes` records each frame
// size asked for. Media's own procedure reads it, as it reads the browser's.
const clip = vi.hoisted(() => ({ seconds: 2, sound: 0, rate: 16_000, sizes: [] as { width: number; height: number }[] }));
vi.mock('@lloyal-labs/media/client', () => ({
  mediabunnyDecoder: vi.fn(() => ({
    duration: async () => clip.seconds,
    picture: async () => ({ width: 1280, height: 720, startS: 0 }),
    async *frames(times: number[], size: { width: number; height: number }) {
      clip.sizes.push(size);
      for (const t of times) yield { shownS: Math.floor(t * 8) / 8, bytes: new Uint8Array([0xff, 0xd8, 0xff]) };
    },
    async *sound() {
      if (clip.sound) yield { shownS: 0, sampleRate: clip.rate, channels: [new Float32Array(clip.sound * clip.rate).fill(0.25)] };
    },
    dispose: () => {},
  })),
  videoDurationMs: vi.fn(async () => clip.seconds * 1000),
}));
/** The made-up clip, `seconds` long with that much sound at `rate`, for one test. */
function clipOf(seconds: number, rate = 16_000) { Object.assign(clip, { seconds, sound: seconds, rate }); }
afterEach(() => Object.assign(clip, { seconds: 2, sound: 0, rate: 16_000, sizes: [] }));

const SAMPLING = { fps: 4, timestampIntervalMs: 5000, maxFrames: 64, maxEdgePx: 640 };
const MAX_MS = 600_000;
const LIMITS = { maxBytes: 16 * 1024 * 1024, maxDurationSeconds: 60, maxChannels: 1, maxSampleRate: 16_000 };

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
      capabilities: { sampling: SAMPLING, maxDurationMs: MAX_MS, transcription: null }, onProgress: (p) => progress.push(p.phase),
    });
    expect(attached.root).toEqual(root);
    const compose = sent.find(c => c.type === 'video:compose') as Extract<VideoCommand, { type: 'video:compose' }>;
    expect(mediabunnyDecoder).toHaveBeenCalledWith(expect.any(Blob));
    expect(clip.sizes).toEqual([{ width: 640, height: 360 }]);   // the host's policy, frame edge included
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
        if (c.type === 'video:describe') emit({ type: 'video:capabilities', capabilities: { sampling: SAMPLING, maxDurationMs: MAX_MS, transcription: null } });
        if (c.type === 'video:compose') emit({ type: 'video:composed', requestId: c.requestId, root: { mediaType: MANIFEST_TYPE, digest: `sha256:${'f'.repeat(64)}`, size: 1 } as never, untranscribed: [] });
      },
    };
    const attached = await ingestVideo({ origin: '', bridge, file: new Blob([new Uint8Array(10)]), capabilities: null });
    expect(sent).toEqual(['video:describe', 'video:compose']);
    expect(attached.root.digest).toBe(`sha256:${'f'.repeat(64)}`);
  });
});

describe('ingestVideo, cancelled before it starts', () => {
  it('rejects at once, asking the host nothing', async () => {
    const sent: string[] = [];
    const bridge = { onEvent: () => () => {}, send: (c: VideoCommand) => { sent.push(c.type); } };
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(ingestVideo({ origin: '', bridge, file: new Blob([new Uint8Array(10)]), capabilities: null, signal: cancelled.signal }))
      .rejects.toThrow();
    expect(sent).toEqual([]);
  });
});

describe('ingestVideo, cancelled while the host composes', () => {
  function silentHost(answer: boolean) {
    vi.mocked(pushBlob).mockResolvedValue({ mediaType: 'video/mp4', digest: `sha256:${'d'.repeat(64)}`, size: 2518 });
    vi.mocked(ingestMedia).mockImplementation(async () => ({ mediaType: MANIFEST_TYPE, digest: `sha256:${'e'.repeat(64)}`, size: 1 }));
    const listeners: Array<(f: Frame<VideoEvent>) => void> = [];
    const sent: string[] = [];
    let composed!: () => void;
    const composing = new Promise<void>((resolve) => { composed = resolve; });
    const bridge = {
      onEvent: (cb: (f: Frame<VideoEvent>) => void) => { listeners.push(cb); return () => { listeners.splice(listeners.indexOf(cb), 1); }; },
      send: (c: VideoCommand) => {
        sent.push(c.type);
        if (c.type !== 'video:compose') return;
        composed();
        if (answer) queueMicrotask(() => [...listeners].forEach(l => l({ ev: { type: 'video:composed', requestId: c.requestId, root: { mediaType: MANIFEST_TYPE, digest: `sha256:${'f'.repeat(64)}`, size: 1 }, untranscribed: [] } } as unknown as Frame<VideoEvent>)));
      },
    };
    return { bridge, sent, listeners, composing };
  }
  const capabilities = { sampling: SAMPLING, maxDurationMs: MAX_MS, transcription: null };

  it('rejects at once, tells the host, and keeps no listener, though the host never answers', async () => {
    const host = silentHost(false);
    const abort = new AbortController();
    const attaching = ingestVideo({ origin: '', bridge: host.bridge, file: new Blob([new Uint8Array(10)]), capabilities, signal: abort.signal });
    await host.composing;
    abort.abort();
    await expect(attaching).rejects.toThrow();
    expect(host.sent).toEqual(['video:compose', 'video:cancel']);
    expect(host.listeners).toEqual([]);
  });

  it('sends nothing when it is aborted as composing begins', async () => {
    const host = silentHost(false);
    const abort = new AbortController();
    const attaching = ingestVideo({
      origin: '', bridge: host.bridge, file: new Blob([new Uint8Array(10)]), capabilities, signal: abort.signal,
      onProgress: (p) => { if (p.phase === 'composing') abort.abort(); },
    });
    await expect(attaching).rejects.toThrow();
    expect(host.sent).toEqual([]);
    expect(host.listeners).toEqual([]);
  });

  it('sends no cancel for a video already composed', async () => {
    const host = silentHost(true);
    const abort = new AbortController();
    await ingestVideo({ origin: '', bridge: host.bridge, file: new Blob([new Uint8Array(10)]), capabilities, signal: abort.signal });
    abort.abort();
    expect(host.sent).toEqual(['video:compose']);
  });
});

/** A host that composes whatever it is sent, and the compose it was sent. */
function composingHost() {
  vi.mocked(pushBlob).mockResolvedValue({ mediaType: 'video/mp4', digest: `sha256:${'d'.repeat(64)}`, size: 2518 });
  vi.mocked(ingestMedia).mockImplementation(async () => ({ mediaType: MANIFEST_TYPE, digest: `sha256:${'e'.repeat(64)}`, size: 1 }));
  const listeners: Array<(f: Frame<VideoEvent>) => void> = [];
  const sent: Extract<VideoCommand, { type: 'video:compose' }>[] = [];
  const bridge = {
    onEvent: (cb: (f: Frame<VideoEvent>) => void) => { listeners.push(cb); return () => { listeners.splice(listeners.indexOf(cb), 1); }; },
    send: (c: VideoCommand) => {
      if (c.type !== 'video:compose') return;
      sent.push(c);
      queueMicrotask(() => [...listeners].forEach(l => l({ ev: { type: 'video:composed', requestId: c.requestId, root: { mediaType: MANIFEST_TYPE, digest: `sha256:${'f'.repeat(64)}`, size: 1 }, untranscribed: [] } } as unknown as Frame<VideoEvent>)));
    },
  };
  return { bridge, compose: () => sent[0] };
}
const lengthOf = (w: { startMs: number; endMs: number }) => w.endMs - w.startMs;

describe('ingestVideo with timestamps off', () => {
  it('still cuts the soundtrack into windows the transcription service can take', async () => {
    clipOf(12, 48_000);
    const host = composingHost();
    await ingestVideo({ origin: '', bridge: host.bridge, file: new Blob([new Uint8Array(10)]), capabilities: { sampling: { ...SAMPLING, timestampIntervalMs: 0 }, maxDurationMs: MAX_MS, transcription: LIMITS } });
    // 5 s windows, which the cutter may end up to a fifth either side.
    expect(lengthOf(host.compose().audio![0])).toBeGreaterThanOrEqual(4000);
    expect(lengthOf(host.compose().audio![0])).toBeLessThanOrEqual(6000);
    // Written no faster than the service admits.
    const windows = vi.mocked(ingestMedia).mock.calls.map(([, bytes]) => bytes as Uint8Array).filter(b => new TextDecoder().decode(b.subarray(0, 4)) === 'RIFF');
    expect(windows.every(w => new DataView(w.buffer, w.byteOffset).getUint32(24, true) <= 16_000)).toBe(true);
  });
});

describe('ingestVideo for a long clip', () => {
  it('cuts the soundtrack at the mark interval its sparse frames are recorded with', async () => {
    // 24 s at a cap of 4 frames: frames 6 s apart, past the 5 s interval, so marks are recorded two frames apart.
    clipOf(24);
    const host = composingHost();
    await ingestVideo({ origin: '', bridge: host.bridge, file: new Blob([new Uint8Array(10)]), capabilities: { sampling: { ...SAMPLING, maxFrames: 4 }, maxDurationMs: MAX_MS, transcription: LIMITS } });
    expect(host.compose().frames.map(f => f.tMs)).toEqual([0, 6000, 12_000, 18_000]);
    // 12 s windows, which the cutter may end up to a fifth either side.
    expect(lengthOf(host.compose().audio![0])).toBeGreaterThanOrEqual(12_000 * 4 / 5);
    expect(lengthOf(host.compose().audio![0])).toBeLessThanOrEqual(12_000 * 6 / 5);
  });
});

describe('ingestVideo for a clip longer than the host takes', () => {
  it('refuses it from the container\'s own duration, before pushing any byte', async () => {
    vi.mocked(pushBlob).mockClear();
    vi.mocked(ingestMedia).mockClear();
    vi.mocked(videoDurationMs).mockResolvedValueOnce(3_600_000);
    const bridge = { onEvent: () => () => {}, send: vi.fn() };
    await expect(ingestVideo({ origin: '', bridge, file: new Blob([new Uint8Array(10)]), capabilities: { sampling: SAMPLING, maxDurationMs: MAX_MS, transcription: LIMITS } }))
      .rejects.toThrow('This video runs 60 min; this harness takes videos up to 10 min.');
    expect(pushBlob).not.toHaveBeenCalled();
    expect(ingestMedia).not.toHaveBeenCalled();
    expect(bridge.send).not.toHaveBeenCalled();
  });
});
