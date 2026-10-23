/**
 * A video's manifest read through the content plane: the transcript is found
 * by its type among the representations, wherever the frames and the
 * soundtrack put it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_MEDIA_TYPE, configUrl, manifestUrl, representationUrl, TRANSCRIPT_MEDIA_TYPE, VIDEO_CONFIG_TYPE } from '@lloyal-labs/media';
import { resolveAsset } from '../src/assets';

const origin = 'http://host';
const digest = `sha256:${'c'.repeat(64)}`;
const layer = (mediaType: string, annotations?: Record<string, string>) => ({ mediaType, ...(annotations ? { annotations } : {}) });
const meta = {
  width: 320, height: 240, durationMs: 4000, poster: 0,
  sampling: { fps: 4, timestampIntervalMs: 5000, maxFrames: 64 },
  frames: [{ tMs: 0, frame: 0 }, { tMs: 250, frame: 1 }],
  soundtrack: [{ startMs: 0, endMs: 2000, audio: 2 }, { startMs: 2000, endMs: 4000, audio: 3 }],
};
const transcript = { provenance: {}, segments: [{ startMs: 0, endMs: 2000, text: 'one, two' }] };

afterEach(() => vi.unstubAllGlobals());

describe('resolveAsset', () => {
  it('finds a video\'s transcript after its soundtrack windows, and keeps the soundtrack on the timeline', async () => {
    const answers: Record<string, unknown> = {
      [manifestUrl(origin, digest)]: {
        config: { mediaType: VIDEO_CONFIG_TYPE },
        layers: [
          layer('image/jpeg'), layer('image/jpeg'), layer(AUDIO_MEDIA_TYPE), layer(AUDIO_MEDIA_TYPE),
          layer(TRANSCRIPT_MEDIA_TYPE), layer('video/mp4', { 'ai.lloyal.role': 'source' }),
        ],
      },
      [configUrl(origin, digest)]: meta,
      [representationUrl(origin, digest, 4)]: transcript,
    };
    vi.stubGlobal('fetch', async (url: string) => ({ json: async () => answers[url] }));

    expect(await resolveAsset(origin, digest)).toEqual({ kind: 'video', meta, source: true, transcript });
  });
});
