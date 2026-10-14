/**
 * @file A video as one attachment, composed by the host from references.
 *
 * The page decodes a clip into frames, each admitted as its own image root,
 * and, when a transcription service is bound, transcribes its soundtrack. The
 * host then composes ONE manifest: the frames' representation descriptors
 * reused in time order, the transcript beside them, a typed timeline as the
 * config, and the original as the source layer when it was retained. A caller
 * never authors the manifest; this is the only place one is made.
 */
import { representationsOf } from './attachment';
import type { Attachment, Descriptor } from './attachment';
import type { AttachmentStore } from './store';
import { imageSize, PROJECTOR_FORMATS, VIDEO_CONTAINER_TYPES, sniffMediaType } from './media-type';

export const VIDEO_CONFIG_TYPE = 'application/vnd.lloyal.video.v1+json' as const;
export const TRANSCRIPT_MEDIA_TYPE = 'application/vnd.lloyal.transcript.v1+json' as const;

/** How a clip was sampled into frames. */
export interface VideoSampling {
  fps: number;
  /** A timestamp joins the layout after the frame that crosses each interval; 0 disables them. */
  timestampIntervalMs: number;
  maxFrames: number;
}

/** A video's timeline: what each representation is, and when. */
export interface VideoMeta {
  width: number;
  height: number;
  durationMs: number;
  /** Frames in time order; `frame` indexes the manifest's representations. */
  frames: { tMs: number; frame: number }[];
  /** The representation shown before playback, a frame index. */
  poster: number;
  sampling: VideoSampling;
}

/** What a transcription service heard, segment by segment, on the clip's timeline. */
export interface Transcript {
  provenance: Record<string, string>;
  segments: { startMs: number; endMs: number; text: string; language?: string }[];
}

/**
 * One video as the projector takes it: frames on a timeline, behind one
 * marker. Structurally the SDK's video `MultimodalInput`, which this package
 * cannot import.
 *
 * @category Media
 */
export interface VideoInput {
  kind: 'video';
  frames: Uint8Array[];
  timestampsMs: number[];
  timestampIntervalMs: number;
  notes?: { atMs: number; text: string }[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
/** Strictly increasing times, the order the native video input requires. */
const increasing = (times: readonly unknown[]): boolean => times.every((t, i) => isMs(t) && (i === 0 || t > (times[i - 1] as number)));
/** A span inside a clip of `durationMs`. */
const withinClip = (startMs: unknown, endMs: unknown, durationMs: number): boolean =>
  isMs(startMs) && isMs(endMs) && startMs <= endMs && endMs <= durationMs;
/** Narrow parsed JSON to a {@link Transcript}, or refuse it. */
export function asTranscript(json: unknown): Transcript | null {
  if (!isObj(json) || !isObj(json.provenance) || !Array.isArray(json.segments)) return null;
  const segmentOk = (s: unknown): boolean =>
    isObj(s) && isMs(s.startMs) && isMs(s.endMs) && s.startMs <= s.endMs && typeof s.text === 'string' &&
    (s.language === undefined || typeof s.language === 'string');
  return Object.values(json.provenance).every(v => typeof v === 'string') && json.segments.every(segmentOk)
    ? json as unknown as Transcript
    : null;
}

/** Narrow parsed JSON to a {@link VideoMeta}, or refuse it. */
export function asVideoMeta(json: unknown): VideoMeta | null {
  if (!isObj(json)) return null;
  const { width, height, durationMs, frames, poster, sampling } = json;
  const positive = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
  const frameOk = (f: unknown): boolean => isObj(f) && isMs(f.tMs) && isMs(f.frame);
  const timesOk = (fs: unknown[]): boolean => {
    const times = fs.map(f => (f as { tMs: unknown }).tMs);
    return increasing(times) && isMs(durationMs) && (times[times.length - 1] as number) <= durationMs;
  };
  const samplingOk = isObj(sampling) && typeof sampling.fps === 'number' && Number.isFinite(sampling.fps) && sampling.fps > 0 &&
    isMs(sampling.timestampIntervalMs) && positive(sampling.maxFrames);
  return positive(width) && positive(height) && isMs(durationMs) && Array.isArray(frames) && frames.length > 0 &&
    frames.every(frameOk) && timesOk(frames) && isMs(poster) &&
    samplingOk
    ? json as unknown as VideoMeta
    : null;
}

/** The one representation an admitted image root carries, or a refusal naming the frame. */
function frameRepresentation(store: AttachmentStore, root: Attachment, index: number): Descriptor {
  const manifest = store.getManifest(root.digest);
  const reps = manifest ? representationsOf(manifest) : [];
  if (reps.length !== 1 || !PROJECTOR_FORMATS.includes(reps[0].mediaType)) {
    throw new Error(`composeVideo: frame ${index} is not an image root in this store`);
  }
  return reps[0];
}

/**
 * Compose one video attachment from admitted frame roots.
 *
 * Pure over the store: it reads the referenced roots, checks they can be one
 * video (images of one size, times increasing within the clip), and commits a
 * manifest that reuses the frames' blobs. Transcription is the caller's
 * concern; this only records what was heard.
 *
 * @param signal - Checked before the first write, so a cancelled composition commits nothing.
 * @throws When the parts cannot be one video, naming why, or when `signal` aborted.
 *
 * @category Media
 */
export async function composeVideo(store: AttachmentStore, parts: {
  frames: readonly { root: Attachment; tMs: number }[];
  sampling: VideoSampling;
  durationMs: number;
  transcript?: Transcript;
  source?: Descriptor;
}, signal?: AbortSignal): Promise<Attachment> {
  const { frames, sampling, durationMs, transcript } = parts;
  if (frames.length === 0) throw new Error('composeVideo: a video needs at least one frame');
  if (frames.length > sampling.maxFrames) {
    throw new Error(`composeVideo: the sampling allows at most ${sampling.maxFrames} frames, not ${frames.length}`);
  }
  const reps = frames.map((f, i) => frameRepresentation(store, f.root, i));
  const sizes = reps.map(r => {
    const bytes = store.get(r.digest);
    return bytes ? imageSize(bytes) : null;
  });
  const [first] = sizes;
  if (!first || sizes.some(s => !s || s.width !== first.width || s.height !== first.height)) {
    throw new Error('composeVideo: video frames must share one size (PNG or JPEG)');
  }
  if (!increasing(frames.map(f => f.tMs))) {
    throw new Error('composeVideo: frame times must increase');
  }
  if (!isMs(durationMs) || frames[frames.length - 1].tMs > durationMs) {
    throw new Error('composeVideo: frame times must fall within the clip');
  }
  if (transcript && !asTranscript(transcript)) throw new Error('composeVideo: the transcript is not well formed');
  transcript?.segments.forEach((segment, i) => {
    if (!withinClip(segment.startMs, segment.endMs, durationMs)) {
      throw new Error(`composeVideo: transcript segment ${i} must fall within the clip`);
    }
  });
  // The source is a blob pushed by a client and stored as opaque bytes; what
  // it IS comes from its own leading bytes, never the descriptor's claim.
  const source = parts.source ? await storedContainer(store, parts.source.digest) : undefined;
  if (parts.source && !source) throw new Error('composeVideo: the source is not a stored video container');

  const meta: VideoMeta = {
    width: first.width,
    height: first.height,
    durationMs,
    frames: frames.map((f, i) => ({ tMs: f.tMs, frame: i })),
    poster: 0,
    sampling: { ...sampling },
  };
  if (!asVideoMeta(meta)) throw new Error('composeVideo: the timeline is not well formed');
  // The last check before the first write: a caller that gave up while the
  // source was read gets nothing committed on its behalf.
  signal?.throwIfAborted();
  const enc = new TextEncoder();
  const transcriptRep = transcript
    ? [store.putBlob(enc.encode(JSON.stringify(transcript)), TRANSCRIPT_MEDIA_TYPE)]
    : [];
  return store.putAttachment({
    representations: [...reps, ...transcriptRep],
    ...(source ? { source } : {}),
    config: { mediaType: VIDEO_CONFIG_TYPE, bytes: enc.encode(JSON.stringify(meta)) },
  });
}

/** A stored blob's descriptor typed by its container signature, or null when it is not a video container. */
async function storedContainer(store: AttachmentStore, digest: string): Promise<Descriptor | null> {
  const size = store.size(digest);
  const head = size ? store.readRange(digest, { start: 0, end: Math.min(size, 64) - 1 }) : null;
  if (!size || !head) return null;
  const reader = head.getReader();
  const chunks: Uint8Array[] = [];
  for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  chunks.reduce((at, c) => (bytes.set(c, at), at + c.byteLength), 0);
  const mediaType = sniffMediaType(bytes);
  return VIDEO_CONTAINER_TYPES.includes(mediaType) ? { mediaType, digest, size } : null;
}

/** A transcript segment as the model reads it, placed at the end of its window. */
const noteOf = (segment: Transcript['segments'][number]): { atMs: number; text: string } =>
  ({ atMs: segment.endMs, text: ` Speech: "${segment.text}"` });

/**
 * Resolve a video root to the input the projector takes, every blob verified.
 *
 * @throws If the root is not a video, or any frame, the transcript or the
 *         timeline is missing or has drifted from its digest.
 *
 * @category Media
 */
export function resolveVideo(store: AttachmentStore, root: Attachment): VideoInput {
  const manifest = store.getManifest(root.digest);
  if (!manifest || manifest.config.mediaType !== VIDEO_CONFIG_TYPE) {
    throw new Error(`resolveVideo: ${root.digest.slice(0, 19)}… is not a video in this store`);
  }
  const read = (d: Descriptor, what: string): Uint8Array => {
    const bytes = store.get(d.digest);
    if (!bytes) throw new Error(`resolveVideo: the ${what} ${d.digest.slice(0, 19)}… is missing or no longer hashes to its digest`);
    return bytes;
  };
  const meta = asVideoMeta(JSON.parse(new TextDecoder().decode(read(manifest.config, 'timeline'))));
  if (!meta) throw new Error('resolveVideo: the video timeline is not well formed');
  const reps = representationsOf(manifest);
  const transcriptRep = reps.find(r => r.mediaType === TRANSCRIPT_MEDIA_TYPE);
  const transcript = transcriptRep
    ? asTranscript(JSON.parse(new TextDecoder().decode(read(transcriptRep, 'transcript'))))
    : null;
  if (transcriptRep && !transcript) throw new Error('resolveVideo: the stored transcript is not well formed');
  const notes = transcript?.segments.filter(s => s.text.trim().length > 0).map(noteOf) ?? [];
  return {
    kind: 'video',
    frames: meta.frames.map(f => {
      const rep = reps[f.frame];
      if (!rep || !PROJECTOR_FORMATS.includes(rep.mediaType)) throw new Error(`resolveVideo: frame ${f.frame} is not an image`);
      return read(rep, 'frame');
    }),
    timestampsMs: meta.frames.map(f => f.tMs),
    timestampIntervalMs: meta.sampling.timestampIntervalMs,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/** Whether these leading bytes are a video container the single-payload ingress refuses. */
export const isVideoContainer = (bytes: Uint8Array): boolean => VIDEO_CONTAINER_TYPES.includes(sniffMediaType(bytes));
