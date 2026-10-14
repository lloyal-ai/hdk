/**
 * Attaching a video from the page: the order of the conversation with the
 * host — the original pushed, every frame and window ingested, then one
 * compose that resolves to the root.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Frame, VideoCommand, VideoEvent } from '@lloyal-labs/binding';
import { MANIFEST_TYPE, ingestMedia, pushBlob } from '@lloyal-labs/media';
import { sampleVideo } from '@lloyal-labs/media/client';
import { ingestVideo } from '../src/video';

vi.mock('@lloyal-labs/media', async (original) => ({ ...await original<object>(), ingestMedia: vi.fn(), pushBlob: vi.fn() }));
// The page's reading of the clip: a 2-second clip sampled at 4 fps, with no soundtrack to cut.
vi.mock('@lloyal-labs/media/client', () => ({
  sampleVideo: vi.fn(async () => ({ durationMs: 2000, frames: [0, 250, 500, 750, 1000, 1250, 1500, 1750].map(tMs => ({ tMs, bytes: new Uint8Array([0xff, 0xd8, 0xff]) })) })),
  extractAudioWindows: vi.fn(async function* () {}),
}));

const SAMPLING = { fps: 4, timestampIntervalMs: 5000, maxFrames: 64, maxEdgePx: 640 };

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
    expect(sampleVideo).toHaveBeenCalledWith(expect.any(Blob), SAMPLING);   // the host's policy, frame edge included
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
