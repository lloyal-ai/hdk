/**
 * A video is one attachment: its sampled frames as representations (each an
 * admitted image root's descriptor, reused), an optional transcript beside
 * them, a typed timeline as config, and the original as its source. The host
 * composes it from references; a caller never authors the manifest.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { FileAttachmentStore } from '../src/file-store';
import { createContentIngress } from '../src/content-ingress';
import { materialize } from '../src/ingress';
import * as media from '../src/index';
import { pcmWav } from './fixtures/audio';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(__dirname, 'fixtures/video', name)));
const FRAMES = ['frame-00.png', 'frame-01.png', 'frame-02.png'].map(fixture);
const MP4 = fixture('red-square-moves.mp4');
const SAMPLING = { fps: 4, timestampIntervalMs: 5000, maxFrames: 64 };

const dirs: string[] = [];
function store(): FileAttachmentStore {
  const dir = mkdtempSync(join(tmpdir(), 'video-media-'));
  dirs.push(dir);
  return new FileAttachmentStore(dir);
}
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

async function frameRoots(content: FileAttachmentStore, frames = FRAMES) {
  const ingress = createContentIngress(content);
  return Promise.all(frames.map(async (bytes, i) => ({ root: await ingress.ingest(bytes), tMs: i * 250 })));
}

const transcript: media.Transcript = {
  provenance: { model: 'qwen3-asr-0.6b' },
  segments: [{ startMs: 0, endMs: 750, text: 'one, two, three', language: 'en' }],
};

describe('video containers at the single-payload ingress', () => {
  it('sniffs mp4, mov and webm by their container signatures', () => {
    expect(media.sniffMediaType(MP4)).toBe('video/mp4');
    const mov = MP4.slice(); mov.set(new TextEncoder().encode('ftypqt  '), 4);
    expect(media.sniffMediaType(mov)).toBe('video/quicktime');
    expect(media.sniffMediaType(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]))).toBe('video/webm');
    expect(media.VIDEO_CONTAINER_TYPES).toEqual(['video/mp4', 'video/quicktime', 'video/webm']);
  });

  it('leaves HEIF and AVIF stills on the image path, though they share the ISO BMFF box', async () => {
    const still = (brand: string) => { const head = MP4.slice(0, 32); head.set(new TextEncoder().encode(`ftyp${brand}`), 4); return head; };
    expect(['heic', 'heix', 'hevc', 'mif1', 'msf1', 'avif', 'avis'].map(b => media.sniffMediaType(still(b))))
      .toEqual(['image/heic', 'image/heic', 'image/heic-sequence', 'image/heif', 'image/heif-sequence', 'image/avif', 'image/avif']);

    const avif = new Uint8Array(await sharp({ create: { width: 64, height: 48, channels: 3, background: '#c00' } }).avif().toBuffer());
    const content = store();
    const root = await createContentIngress(content).ingest(avif);
    expect(media.representationsOf(content.getManifest(root.digest)!)[0].mediaType).toBe('image/jpeg');
  });

  it('refuses raw video bytes, naming where video is decoded, and stores nothing', async () => {
    const content = store();
    await expect(createContentIngress(content).ingest(MP4)).rejects.toThrow(/video is decoded on the page/);
    expect(readdirSync(dirs[0])).toEqual([]);
  });
});

describe('composeVideo', () => {
  it('composes frames, transcript, timeline and source into one manifest, reusing the frame blobs', async () => {
    const content = store();
    const frames = await frameRoots(content);
    // Pushed as opaque bytes; the composition types it from its own signature.
    const source = content.putBlob(MP4, 'application/octet-stream');
    const root = await media.composeVideo(content, { frames, sampling: SAMPLING, durationMs: 4000, transcript, source });

    const manifest = content.getManifest(root.digest)!;
    expect(manifest.config.mediaType).toBe(media.VIDEO_CONFIG_TYPE);
    const reps = media.representationsOf(manifest);
    const frameReps = frames.map(f => media.representationsOf(content.getManifest(f.root.digest)!)[0]);
    expect(reps.slice(0, 3).map(r => r.digest)).toEqual(frameReps.map(r => r.digest));
    expect(reps[3].mediaType).toBe(media.TRANSCRIPT_MEDIA_TYPE);
    expect(media.sourceOf(manifest)).toMatchObject({ digest: source.digest, mediaType: 'video/mp4', size: MP4.byteLength });

    const meta = media.asVideoMeta(JSON.parse(new TextDecoder().decode(content.get(manifest.config.digest)!)))!;
    expect(meta).toMatchObject({ width: 320, height: 240, durationMs: 4000, poster: 0, sampling: SAMPLING });
    expect(meta.frames).toEqual([{ tMs: 0, frame: 0 }, { tMs: 250, frame: 1 }, { tMs: 500, frame: 2 }]);
  });

  it('a live capture composes without a source or a transcript', async () => {
    const content = store();
    const root = await media.composeVideo(content, { frames: await frameRoots(content), sampling: SAMPLING, durationMs: 750 });
    const manifest = content.getManifest(root.digest)!;
    expect(media.sourceOf(manifest)).toBeUndefined();
    expect(media.representationsOf(manifest)).toHaveLength(3);
  });

  it('refuses what cannot be one video', async () => {
    const content = store();
    const frames = await frameRoots(content);
    const other = await createContentIngress(content).ingest(
      new Uint8Array(await sharp({ create: { width: 64, height: 48, channels: 3, background: '#fff' } }).png().toBuffer()));
    const audio = await createContentIngress(content).ingest(pcmWav());
    const compose = (parts: Partial<Parameters<typeof media.composeVideo>[1]>) =>
      media.composeVideo(content, { frames, sampling: SAMPLING, durationMs: 4000, ...parts });

    await expect(compose({ frames: [] })).rejects.toThrow(/at least one frame/);
    await expect(compose({ frames: [...frames, { root: other, tMs: 900 }] })).rejects.toThrow(/share one size/);
    await expect(compose({ frames: [frames[0], { ...frames[2], tMs: 0 }] })).rejects.toThrow(/times must increase/);
    await expect(compose({ durationMs: 400 })).rejects.toThrow(/within the clip/);
    await expect(compose({ frames: [{ root: audio, tMs: 0 }] })).rejects.toThrow(/not an image/);
    await expect(compose({ source: { mediaType: 'video/mp4', digest: `sha256:${'0'.repeat(64)}`, size: 1 } })).rejects.toThrow(/source/);
    const notVideo = content.putBlob(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'video/mp4');
    await expect(compose({ source: notVideo })).rejects.toThrow(/source/);
    await expect(compose({ transcript: { provenance: {}, segments: [{ startMs: 500, endMs: 100, text: 'x' }] } })).rejects.toThrow(/transcript/);
    // A soundtrack window is a reference like a frame: it must be a recording this store admitted, inside the clip.
    await expect(compose({ audio: [{ root: frames[0].root, startMs: 0, endMs: 500 }] })).rejects.toThrow(/window 0 is not a recording/);
    await expect(compose({ audio: [{ root: audio, startMs: 0, endMs: 9000 }] })).rejects.toThrow(/window 0 must fall within the clip/);
    await expect(compose({ audio: [{ root: audio, startMs: 0, endMs: 500 }] })).resolves.toBeDefined();
  });
});

describe('materialize and resolveVideo', () => {
  it('a video is ONE typed input: frames on a timeline, its transcript as notes', async () => {
    const content = store();
    const root = await media.composeVideo(content, { frames: await frameRoots(content), sampling: SAMPLING, durationMs: 4000, transcript });
    const [input] = materialize(content, [root]).inputs;
    expect(input).toMatchObject({ kind: 'video', timestampsMs: [0, 250, 500], timestampIntervalMs: 5000 });
    const video = input as media.VideoInput;
    expect(video.frames).toHaveLength(3);
    expect(video.notes).toEqual([{ atMs: 750, text: ' Speech: "one, two, three"' }]);
    expect(media.resolveVideo(content, root)).toEqual(video);
  });

  it('keeps marker order across images, videos and documents: one input per projected root', async () => {
    const content = store();
    const image = await createContentIngress(content).ingest(FRAMES[0]);
    const video = await media.composeVideo(content, { frames: await frameRoots(content), sampling: SAMPLING, durationMs: 4000 });
    const audio = await createContentIngress(content).ingest(pcmWav());
    const inputs = materialize(content, [image, audio, video, image]).inputs;
    expect(inputs.map(i => i instanceof Uint8Array ? 'image' : i.kind)).toEqual(['image', 'video', 'image']);
  });

  it('a stored transcript that drifted from its digest refuses replay', async () => {
    const content = store();
    const root = await media.composeVideo(content, { frames: await frameRoots(content), sampling: SAMPLING, durationMs: 4000, transcript });
    const manifest = content.getManifest(root.digest)!;
    const rep = media.representationsOf(manifest).find(r => r.mediaType === media.TRANSCRIPT_MEDIA_TYPE)!;
    const file = join(dirs[0], 'blobs', 'sha256', rep.digest.slice(7));
    rmSync(file);
    expect(() => materialize(content, [root])).toThrow(/transcript/);
  });
});

describe('guards', () => {
  it('asTranscript and asVideoMeta refuse what is not their shape', () => {
    expect(media.asTranscript(transcript)).toEqual(transcript);
    expect(media.asTranscript({ provenance: {}, segments: [{ startMs: 0, endMs: 1 }] })).toBeNull();
    expect(media.asVideoMeta({ width: 1 })).toBeNull();
  });

  it('asVideoMeta refuses a stored timeline the model could not take: frames out of order, or past the clip', () => {
    const meta = { width: 320, height: 240, durationMs: 1000, poster: 0, sampling: SAMPLING, frames: [{ tMs: 0, frame: 0 }, { tMs: 500, frame: 1 }] };
    expect(media.asVideoMeta(meta)).not.toBeNull();
    expect(media.asVideoMeta({ ...meta, frames: [{ tMs: 500, frame: 0 }, { tMs: 0, frame: 1 }] })).toBeNull();
    expect(media.asVideoMeta({ ...meta, frames: [{ tMs: 0, frame: 0 }, { tMs: 0, frame: 1 }] })).toBeNull();
    expect(media.asVideoMeta({ ...meta, frames: [{ tMs: 0, frame: 0 }, { tMs: 1500, frame: 1 }] })).toBeNull();
    const window = { startMs: 0, endMs: 1500, root: { mediaType: 'x', digest: `sha256:${'a'.repeat(64)}`, size: 1 } };
    expect(media.asVideoMeta({ ...meta, audio: [window] })).toBeNull();
  });

  it('composes no timeline that would not read back: a rate JSON cannot hold is refused', async () => {
    const content = store();
    const frames = await frameRoots(content);
    await expect(media.composeVideo(content, { frames, sampling: { ...SAMPLING, fps: Infinity }, durationMs: 4000 }))
      .rejects.toThrow(/timeline is not well formed/);
  });
});
