/**
 * `video:compose`: the host turns frame and soundtrack references into one
 * video attachment, transcribing each window through the bound transcription
 * service when there is one. A failed window is reported, never dropped
 * silently; a cancelled compose commits nothing it did not already write.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { run, sleep, suspend } from 'effection';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Attachments } from '@lloyal-labs/lloyal-agents';
import { DEFAULT_AUDIO_ADMISSION, TRANSCRIPT_MEDIA_TYPE, VIDEO_CONFIG_TYPE, materialize, representationsOf } from '@lloyal-labs/media';
import { FileAttachmentStore, createContentIngress } from '@lloyal-labs/media/node';
import type { Attachment } from '@lloyal-labs/media';
import type { VideoEvent } from '@lloyal-labs/binding';
import { Services } from '../src/services';
import { DEFAULT_VIDEO_MAX_DURATION_MS, DEFAULT_VIDEO_SAMPLING, useVideoCommands } from '../src/video';
import type { Transcription } from '../src/transcription';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(__dirname, '../../media/test/fixtures/video', name)));
const FRAMES = ['frame-00.png', 'frame-01.png', 'frame-02.png'].map(fixture);

/** A minimal 16 kHz mono PCM WAV of `n` samples, all `value`. */
function wav(n: number, value = 1000): Uint8Array {
  const bytes = new Uint8Array(44 + n * 2);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0); view.setUint32(4, 36 + n * 2, true);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode('data'), 36); view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) view.setInt16(44 + i * 2, value, true);
  return bytes;
}

const dirs: string[] = [];
function store(): FileAttachmentStore {
  const dir = mkdtempSync(join(tmpdir(), 'video-commands-'));
  dirs.push(dir);
  return new FileAttachmentStore(dir);
}
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

async function parts(content: FileAttachmentStore) {
  const ingress = createContentIngress(content);
  const frames = await Promise.all(FRAMES.map(async (bytes, i) => ({ root: await ingress.ingest(bytes), tMs: i * 250 })));
  const audio = [
    { root: await ingress.ingest(wav(8000)), startMs: 0, endMs: 500 },
    { root: await ingress.ingest(wav(8000, 0)), startMs: 500, endMs: 1000 },
    { root: await ingress.ingest(wav(4000)), startMs: 1000, endMs: 1250 },
  ];
  return { frames, audio };
}

const heard = (audio: Attachment, text: string, silent = false): Transcription => ({
  text, audio, representation: { digest: `sha256:${'b'.repeat(64)}`, size: 4, mediaType: 'audio/wav' },
  durationSeconds: 0.5, silent, ...(silent ? {} : { language: 'English' }),
  provenance: { model: 'Qwen3-ASR-0.6B', projector: 'mmproj', sampleRate: 16000, context: 4096, maxTokens: 512 },
});

describe('video commands', () => {
  it('describes the sampling it composes under, and the limits a soundtrack window must meet to be transcribed', async () => {
    const limits = { ...DEFAULT_AUDIO_ADMISSION, maxDurationSeconds: 2 };
    for (const bound of [false, true]) {
      const events: VideoEvent[] = [];
      await run(function* () {
        yield* Attachments.set(store());
        yield* Services.set(bound ? { transcription: { limits, *transcribe() { throw new Error('unused'); } } } : {});
        const group = yield* useVideoCommands({ wire: { *send(e) { events.push(e); } } });
        yield* group.handlers['video:describe']!({ type: 'video:describe' });
      });
      // No service, no limits: the page extracts no soundtrack.
      expect(events).toEqual([{ type: 'video:capabilities', capabilities: { sampling: DEFAULT_VIDEO_SAMPLING, maxDurationMs: DEFAULT_VIDEO_MAX_DURATION_MS, transcription: bound ? limits : null } }]);
    }
  });

  it('composes the frames, transcribes the soundtrack window by window, skips silence and reports failures', async () => {
    const content = store();
    const { frames, audio } = await parts(content);
    const events: VideoEvent[] = [];
    let calls = 0;
    await run(function* () {
      yield* Attachments.set(content);
      yield* Services.set({ transcription: { limits: DEFAULT_AUDIO_ADMISSION, *transcribe(window) {
        calls++;
        if (window.digest === audio[1].root.digest) return heard(window, '', true);
        if (window.digest === audio[2].root.digest) throw new Error('the decoder ran out of context');
        return heard(window, 'one, two, three');
      } } });
      const group = yield* useVideoCommands({ wire: { *send(e) { events.push(e); } } });
      yield* group.handlers['video:compose']!({ type: 'video:compose', requestId: 'v1', frames, audio, durationMs: 1250 });
      for (let i = 0; i < 50 && !events.some(e => e.type === 'video:composed' || e.type === 'video:error'); i++) yield* sleep(5);
    });
    expect(calls).toBe(3);
    expect(events.filter(e => e.type === 'video:progress').map(e => (e as { done: number }).done)).toEqual([0, 1, 2, 3]);
    const composed = events.find(e => e.type === 'video:composed') as Extract<VideoEvent, { type: 'video:composed' }>;
    expect(composed.untranscribed).toEqual([{ startMs: 1000, endMs: 1250, reason: 'the decoder ran out of context' }]);
    const manifest = content.getManifest(composed.root.digest)!;
    expect(manifest.config.mediaType).toBe(VIDEO_CONFIG_TYPE);
    const transcript = representationsOf(manifest).find(r => r.mediaType === TRANSCRIPT_MEDIA_TYPE)!;
    expect(JSON.parse(new TextDecoder().decode(content.get(transcript.digest)!))).toEqual({
      provenance: { model: 'Qwen3-ASR-0.6B', projector: 'mmproj', sampleRate: '16000', context: '4096', maxTokens: '512' },
      segments: [{ startMs: 0, endMs: 500, text: 'one, two, three', language: 'English' }],
    });
    expect(materialize(content, [composed.root]).inputs).toHaveLength(1);
    // Every window is kept for models, heard or not: silence and a failed transcription are still sound.
    const meta = JSON.parse(new TextDecoder().decode(content.get(manifest.config.digest)!));
    expect(meta.soundtrack).toEqual(audio.map((w, i) => ({ startMs: w.startMs, endMs: w.endMs, audio: frames.length + i })));
  });

  it('refuses a clip longer than it takes, before transcribing anything', async () => {
    const content = store();
    const { frames, audio } = await parts(content);
    const events: VideoEvent[] = [];
    let heardAny = 0;
    await run(function* () {
      yield* Attachments.set(content);
      yield* Services.set({ transcription: { limits: DEFAULT_AUDIO_ADMISSION, *transcribe(a) { heardAny++; return heard(a, 'x'); } } });
      const group = yield* useVideoCommands({ wire: { *send(e) { events.push(e); } }, maxDurationMs: 1000 });
      yield* group.handlers['video:compose']!({ type: 'video:compose', requestId: 'long', frames, audio, durationMs: 1250 });
      for (let i = 0; i < 50 && !events.some(e => e.type === 'video:error'); i++) yield* sleep(5);
    });
    expect(events).toEqual([{ type: 'video:error', requestId: 'long', message: 'This video runs 1.3 s; this harness takes videos up to 1 s.' }]);
    expect(heardAny).toBe(0);
  });

  it('announces no transcription for a video without a soundtrack', async () => {
    const content = store();
    const { frames } = await parts(content);
    const events: VideoEvent[] = [];
    await run(function* () {
      yield* Attachments.set(content);
      const group = yield* useVideoCommands({ wire: { *send(e) { events.push(e); } } });
      yield* group.handlers['video:compose']!({ type: 'video:compose', requestId: 'silent', frames, durationMs: 1250 });
      for (let i = 0; i < 50 && !events.some(e => e.type === 'video:composed'); i++) yield* sleep(5);
    });
    expect(events.map(e => e.type)).toEqual(['video:composed']);
  });

  it('refuses a soundtrack window that is not an admitted recording, runs past the clip or overlaps the one before it, before transcribing anything', async () => {
    const content = store();
    const { frames, audio } = await parts(content);
    for (const transcribing of [false, true]) {
      const events: VideoEvent[] = [];
      let heardAny = 0;
      await run(function* () {
        yield* Attachments.set(content);
        yield* Services.set(transcribing ? { transcription: { limits: DEFAULT_AUDIO_ADMISSION, *transcribe(a) { heardAny++; return heard(a, 'x'); } } } : {});
        const group = yield* useVideoCommands({ wire: { *send(e) { events.push(e); } } });
        yield* group.handlers['video:compose']!({ type: 'video:compose', requestId: 'forged', frames, audio: [{ root: frames[0].root, startMs: 0, endMs: 500 }], durationMs: 1250 });
        yield* group.handlers['video:compose']!({ type: 'video:compose', requestId: 'late', frames, audio: [{ ...audio[0], startMs: 1000, endMs: 2000 }], durationMs: 1250 });
        yield* group.handlers['video:compose']!({ type: 'video:compose', requestId: 'unordered', frames, audio: [audio[1], audio[0]], durationMs: 1250 });
        for (let i = 0; i < 50 && events.filter(e => e.type === 'video:error').length < 3; i++) yield* sleep(5);
      });
      expect(events).toContainEqual({ type: 'video:error', requestId: 'unordered', message: 'Soundtrack windows must follow one another.' });
      expect(events).toContainEqual(expect.objectContaining({ type: 'video:error', requestId: 'forged', message: expect.stringMatching(/^Soundtrack window 0 is not an admitted recording/) }));
      expect(events).toContainEqual({ type: 'video:error', requestId: 'late', message: 'Soundtrack window 0 runs past the end of the clip.' });
      expect(events.some(e => e.type === 'video:composed')).toBe(false);
      expect(heardAny).toBe(0);
    }
  });

  it('names nothing in its timeline that its OCI graph leaves out, so a copy of the video is whole', async () => {
    const content = store();
    const { frames, audio } = await parts(content);
    const events: VideoEvent[] = [];
    await run(function* () {
      yield* Attachments.set(content);
      const group = yield* useVideoCommands({ wire: { *send(e) { events.push(e); } } });
      yield* group.handlers['video:compose']!({ type: 'video:compose', requestId: 'g1', frames, audio, durationMs: 1250 });
      for (let i = 0; i < 50 && !events.some(e => e.type === 'video:composed'); i++) yield* sleep(5);
    });
    const composed = events.find(e => e.type === 'video:composed') as Extract<VideoEvent, { type: 'video:composed' }>;
    const manifest = content.getManifest(composed.root.digest)!;
    const graph = new Set([manifest.config.digest, ...manifest.layers.map(l => l.digest)]);
    const named = [...new TextDecoder().decode(content.get(manifest.config.digest)!).matchAll(/sha256:[0-9a-f]{64}/g)].map(m => m[0]);
    expect(named.filter(d => !graph.has(d))).toEqual([]);
  });

  it('without a transcription service, the soundtrack is reported untranscribed and the video still composes', async () => {
    const content = store();
    const { frames, audio } = await parts(content);
    const events: VideoEvent[] = [];
    await run(function* () {
      yield* Attachments.set(content);
      const group = yield* useVideoCommands({ wire: { *send(e) { events.push(e); } } });
      yield* group.handlers['video:compose']!({ type: 'video:compose', requestId: 'v2', frames, audio, durationMs: 1250 });
      for (let i = 0; i < 50 && !events.some(e => e.type === 'video:composed'); i++) yield* sleep(5);
    });
    const composed = events.find(e => e.type === 'video:composed') as Extract<VideoEvent, { type: 'video:composed' }>;
    expect(composed.untranscribed.map(w => w.reason)).toEqual(Array(3).fill('transcription is not configured'));
  });

  it('composes under the host\'s own sampling, and refuses more frames than it samples', async () => {
    const content = store();
    const { frames } = await parts(content);
    const events: VideoEvent[] = [];
    const sampling = { fps: 2, timestampIntervalMs: 5000, maxFrames: 2, maxEdgePx: 320 };
    await run(function* () {
      yield* Attachments.set(content);
      const group = yield* useVideoCommands({ wire: { *send(e) { events.push(e); } }, sampling });
      yield* group.handlers['video:compose']!({ type: 'video:compose', requestId: 'over', frames, durationMs: 1250 });
      yield* group.handlers['video:compose']!({ type: 'video:compose', requestId: 'within', frames: frames.slice(0, 2), durationMs: 1250 });
      for (let i = 0; i < 50 && events.length < 2; i++) yield* sleep(5);
    });
    expect(events).toContainEqual({ type: 'video:error', requestId: 'over', message: 'This host composes at most 2 frames a video, not 3.' });
    const composed = events.find(e => e.type === 'video:composed') as Extract<VideoEvent, { type: 'video:composed' }>;
    const config = content.getManifest(composed.root.digest)!.config;
    expect(JSON.parse(new TextDecoder().decode(content.get(config.digest)!)).sampling).toEqual({ fps: 2, timestampIntervalMs: 5000, maxFrames: 2 });
  });

  it('refuses references that are not admitted roots, and an invalid composition, by name', async () => {
    const content = store();
    const { frames } = await parts(content);
    const events: VideoEvent[] = [];
    await run(function* () {
      yield* Attachments.set(content);
      const group = yield* useVideoCommands({ wire: { *send(e) { events.push(e); } } });
      yield* group.handlers['video:compose']!({ type: 'video:compose', requestId: 'bad', frames: [{ root: { mediaType: 'image/png', digest: 'x', size: 1 }, tMs: 0 }], durationMs: 100 });
      yield* group.handlers['video:compose']!({ type: 'video:compose', requestId: 'late', frames, durationMs: 100 });
      for (let i = 0; i < 50 && events.length < 2; i++) yield* sleep(5);
    });
    expect(events).toContainEqual({ type: 'video:error', requestId: 'bad', message: 'A frame is not an admitted image reference.' });
    expect(events).toContainEqual({ type: 'video:error', requestId: 'late', message: 'composeVideo: frame times must fall within the clip' });
  });

  it('cancel stops a compose mid-transcription and nothing is composed', async () => {
    const content = store();
    const { frames, audio } = await parts(content);
    const events: VideoEvent[] = [];
    await run(function* () {
      yield* Attachments.set(content);
      yield* Services.set({ transcription: { limits: DEFAULT_AUDIO_ADMISSION, *transcribe() { yield* suspend(); return heard(audio[0].root, ''); } } });
      const group = yield* useVideoCommands({ wire: { *send(e) { events.push(e); } } });
      yield* group.handlers['video:compose']!({ type: 'video:compose', requestId: 'v3', frames, audio, durationMs: 1250 });
      yield* sleep(5);
      yield* group.handlers['video:cancel']!({ type: 'video:cancel', requestId: 'v3' });
      yield* sleep(5);
    });
    expect(events.at(-1)).toEqual({ type: 'video:cancelled', requestId: 'v3' });
    expect(events.some(e => e.type === 'video:composed')).toBe(false);
  });

  it('a compose under an id already in flight is refused, and the first stays cancellable', async () => {
    const content = store();
    const { frames, audio } = await parts(content);
    const events: VideoEvent[] = [];
    await run(function* () {
      yield* Attachments.set(content);
      yield* Services.set({ transcription: { limits: DEFAULT_AUDIO_ADMISSION, *transcribe() { yield* suspend(); return heard(audio[0].root, ''); } } });
      const group = yield* useVideoCommands({ wire: { *send(e) { events.push(e); } } });
      yield* group.handlers['video:compose']!({ type: 'video:compose', requestId: 'v4', frames, audio, durationMs: 1250 });
      yield* sleep(5);
      yield* group.handlers['video:compose']!({ type: 'video:compose', requestId: 'v4', frames, durationMs: 1250 });
      yield* sleep(5);
      yield* group.handlers['video:cancel']!({ type: 'video:cancel', requestId: 'v4' });
      yield* sleep(5);
    });
    expect(events).toContainEqual({ type: 'video:error', requestId: 'v4', message: 'A video is already being composed under that request.' });
    expect(events.at(-1)).toEqual({ type: 'video:cancelled', requestId: 'v4' });
    expect(events.some(e => e.type === 'video:composed')).toBe(false);
  });
});
