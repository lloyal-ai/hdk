/**
 * Attaching a video from the page: the order of the conversation with the
 * host — the original pushed, every frame and window ingested, then one
 * compose that resolves to the root.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Frame, VideoCommand, VideoEvent } from '@lloyal-labs/binding';
import { MANIFEST_TYPE, ingestMedia, pushBlob } from '@lloyal-labs/media';
import { extractAudioWindows, sampleVideo, videoDurationMs } from '@lloyal-labs/media/client';
import { ingestVideo } from '../src/video';

vi.mock('@lloyal-labs/media', async (original) => ({ ...await original<object>(), ingestMedia: vi.fn(), pushBlob: vi.fn() }));
// The page's reading of the clip: a 2-second clip sampled at 4 fps, with no soundtrack to cut.
vi.mock('@lloyal-labs/media/client', () => ({
  sampleVideo: vi.fn(async () => ({ durationMs: 2000, frames: [0, 250, 500, 750, 1000, 1250, 1500, 1750].map(tMs => ({ tMs, bytes: new Uint8Array([0xff, 0xd8, 0xff]) })) })),
  extractAudioWindows: vi.fn(async function* () {}),
  videoDurationMs: vi.fn(async () => 2000),
  soundtrackWindowMs: (s: { timestampIntervalMs: number }) => (s.timestampIntervalMs > 0 ? s.timestampIntervalMs : 5000),
}));

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
    expect(sampleVideo).toHaveBeenCalledWith(expect.any(Blob), SAMPLING, {});   // the host's policy, frame edge included
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

describe('ingestVideo with timestamps off', () => {
  it('still cuts the soundtrack into windows the transcription service can take', async () => {
    vi.mocked(pushBlob).mockResolvedValue({ mediaType: 'video/mp4', digest: `sha256:${'d'.repeat(64)}`, size: 2518 });
    vi.mocked(ingestMedia).mockImplementation(async () => ({ mediaType: MANIFEST_TYPE, digest: `sha256:${'e'.repeat(64)}`, size: 1 }));
    const listeners: Array<(f: Frame<VideoEvent>) => void> = [];
    const bridge = {
      onEvent: (cb: (f: Frame<VideoEvent>) => void) => { listeners.push(cb); return () => { listeners.splice(listeners.indexOf(cb), 1); }; },
      send: (c: VideoCommand) => {
        if (c.type === 'video:compose') queueMicrotask(() => [...listeners].forEach(l => l({ ev: { type: 'video:composed', requestId: c.requestId, root: { mediaType: MANIFEST_TYPE, digest: `sha256:${'f'.repeat(64)}`, size: 1 }, untranscribed: [] } } as unknown as Frame<VideoEvent>)));
      },
    };
    await ingestVideo({ origin: '', bridge, file: new Blob([new Uint8Array(10)]), capabilities: { sampling: { ...SAMPLING, timestampIntervalMs: 0 }, maxDurationMs: MAX_MS, transcription: LIMITS } });
    expect(vi.mocked(extractAudioWindows).mock.calls.at(-1)?.[1]).toBe(5000);
    // Written no faster than the service admits.
    expect(vi.mocked(extractAudioWindows).mock.calls.at(-1)?.[2]).toMatchObject({ maxSampleRate: 16_000 });
  });
});

describe('ingestVideo for a long clip', () => {
  it('cuts the soundtrack at the mark interval its sparse frames are recorded with', async () => {
    vi.mocked(pushBlob).mockResolvedValue({ mediaType: 'video/mp4', digest: `sha256:${'d'.repeat(64)}`, size: 2518 });
    vi.mocked(ingestMedia).mockImplementation(async () => ({ mediaType: MANIFEST_TYPE, digest: `sha256:${'e'.repeat(64)}`, size: 1 }));
    // Frames 6 s apart: past the 5 s interval, so marks are recorded two frames apart.
    vi.mocked(sampleVideo).mockResolvedValueOnce({ durationMs: 24_000, frames: [0, 6000, 12_000, 18_000].map(tMs => ({ tMs, bytes: new Uint8Array([0xff, 0xd8, 0xff]) })) } as never);
    const listeners: Array<(f: Frame<VideoEvent>) => void> = [];
    const bridge = {
      onEvent: (cb: (f: Frame<VideoEvent>) => void) => { listeners.push(cb); return () => { listeners.splice(listeners.indexOf(cb), 1); }; },
      send: (c: VideoCommand) => {
        if (c.type === 'video:compose') queueMicrotask(() => [...listeners].forEach(l => l({ ev: { type: 'video:composed', requestId: c.requestId, root: { mediaType: MANIFEST_TYPE, digest: `sha256:${'f'.repeat(64)}`, size: 1 }, untranscribed: [] } } as unknown as Frame<VideoEvent>)));
      },
    };
    await ingestVideo({ origin: '', bridge, file: new Blob([new Uint8Array(10)]), capabilities: { sampling: SAMPLING, maxDurationMs: MAX_MS, transcription: LIMITS } });
    expect(vi.mocked(extractAudioWindows).mock.calls.at(-1)?.[1]).toBe(12_000);
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
