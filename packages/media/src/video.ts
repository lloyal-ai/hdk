/**
 * @file A video as one attachment, composed by the host from references.
 *
 * The page decodes a clip into frames, each admitted as its own image root,
 * and cuts its soundtrack into windows, each admitted as a recording. The host
 * transcribes the windows when a transcription service is bound, then composes
 * ONE manifest: the frames' and the windows' representation descriptors
 * reused in time order, the transcript beside them, a typed timeline as the
 * config, and the original as the source layer when it was retained. A caller
 * never authors the manifest; this is the only place one is made.
 */
import { representationsOf, sourceOf } from './attachment';
import type { Attachment, Descriptor } from './attachment';
import { AUDIO_MEDIA_TYPE, inspectPcmWav, recordingOf } from './audio';
import type { AudioAdmission } from './audio';
import { ContentLost } from './store';
import type { AttachmentStore } from './store';
import { imageSize, PROJECTOR_FORMATS, VIDEO_CONTAINER_TYPES, sniffMediaType } from './media-type';

export const VIDEO_CONFIG_TYPE = 'application/vnd.lloyal.video.v1+json' as const;
export const TRANSCRIPT_MEDIA_TYPE = 'application/vnd.lloyal.transcript.v1+json' as const;

/** The quality a video frame is encoded at, as a canvas takes it (0 to 1): by the page, and by a host that decodes. */
export const FRAME_JPEG_QUALITY = 0.85;

/** How a clip was sampled into frames. */
export interface VideoSampling {
  fps: number;
  /** A timestamp joins the layout after the frame that crosses each interval; 0 disables them. In a
   *  stored timeline it is the interval the marks were laid out at, which {@link markInterval} may
   *  have widened past the policy's. */
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
  /** The soundtrack's windows in time order; `audio` indexes the manifest's
   *  representations. The original plays with sound; these are what a model
   *  that hears is given. Absent when the clip had no soundtrack. */
  soundtrack?: { startMs: number; endMs: number; audio: number }[];
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
/** Spans in time order, each starting where or after the one before it ends. */
const followOneAnother = (spans: readonly { startMs: number; endMs: number }[]): boolean =>
  spans.every((s, i) => i === 0 || s.startMs >= spans[i - 1].endMs);
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
  const soundtrackOk = json.soundtrack === undefined || (Array.isArray(json.soundtrack) && isMs(durationMs) &&
    json.soundtrack.every(w => isObj(w) && withinClip(w.startMs, w.endMs, durationMs) && isMs(w.audio)) &&
    followOneAnother(json.soundtrack as { startMs: number; endMs: number }[]));
  return positive(width) && positive(height) && isMs(durationMs) && Array.isArray(frames) && frames.length > 0 &&
    frames.every(frameOk) && timesOk(frames) && isMs(poster) &&
    samplingOk && soundtrackOk
    ? json as unknown as VideoMeta
    : null;
}

/**
 * The interval a clip's time marks are recorded at: the sampling's own, or
 * twice the widest gap between its frames when that is longer. A mark follows
 * the frame that crosses each interval, so no two neighbouring frames are both
 * followed by one, and a projector that merges frames two at a time still
 * fuses them however sparsely a long clip was sampled. A clip sampled without
 * marks stays without them. Composition records it; the page cuts the
 * soundtrack by it, so a window's words join the mark that closes it.
 *
 * @category Media
 */
export function markInterval(frameTimesMs: readonly number[], sampling: Pick<VideoSampling, 'timestampIntervalMs'>): number {
  const widestGap = Math.max(0, ...frameTimesMs.slice(1).map((t, i) => t - frameTimesMs[i]));
  return sampling.timestampIntervalMs > 0 ? Math.max(sampling.timestampIntervalMs, 2 * widestGap) : 0;
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

/** The one representation an admitted recording carries, or a refusal naming the window. */
function soundtrackRepresentation(store: AttachmentStore, root: Attachment, index: number): Descriptor {
  try {
    return recordingOf(store, root).representation;
  } catch {
    throw new Error(`composeVideo: soundtrack window ${index} is not a recording in this store`);
  }
}

/**
 * The sentence refusing a soundtrack's place on a clip of `durationMs`, if a
 * window ends before it starts, runs past the clip, or overlaps the one before
 * it. The host asks this before transcribing anything; composition asks it again.
 *
 * @category Media
 */
export function soundtrackRefusal(windows: readonly { startMs: unknown; endMs: unknown }[], durationMs: unknown): string | undefined {
  const placed = (w: { startMs: unknown; endMs: unknown }, i: number): string | undefined =>
    !isMs(w.startMs) || !isMs(w.endMs) ? `Soundtrack window ${i} has no time on the clip.`
    : w.startMs > w.endMs ? `Soundtrack window ${i} ends before it starts.`
    : !isMs(durationMs) || !withinClip(w.startMs, w.endMs, durationMs) ? `Soundtrack window ${i} runs past the end of the clip.`
    : undefined;
  return windows.map(placed).find((r) => r !== undefined)
    ?? (followOneAnother(windows as readonly { startMs: number; endMs: number }[]) ? undefined : 'Soundtrack windows must follow one another.');
}

/**
 * Compose one video attachment from admitted frame roots.
 *
 * Pure over the store: it reads the referenced roots, checks they can be one
 * video (images of one size, times increasing within the clip; recordings
 * that follow one another within it), and commits a manifest that reuses the
 * frames' and recordings' blobs. The timeline records the sampling
 * with the mark interval its frames need ({@link markInterval}). Transcription is the caller's concern; this
 * only records what was heard.
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
  soundtrack?: readonly { root: Attachment; startMs: number; endMs: number }[];
  transcript?: Transcript;
  source?: Descriptor;
}, signal?: AbortSignal): Promise<Attachment> {
  const { frames, sampling, durationMs, soundtrack = [], transcript } = parts;
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
  const heard = soundtrack.map((w, i) => soundtrackRepresentation(store, w.root, i));
  const offTimeline = soundtrackRefusal(soundtrack, durationMs);
  if (offTimeline) throw new Error(`composeVideo: ${offTimeline}`);
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

  // The last check before the first write: a caller that gave up while the
  // source was read gets nothing committed on its behalf.
  signal?.throwIfAborted();
  const recorded = { ...sampling, timestampIntervalMs: markInterval(frames.map(f => f.tMs), sampling) };
  return commitVideo(store, 'composeVideo', timeline(first, durationMs, recorded, frames, soundtrack), [...reps, ...heard], transcript, source ?? undefined);
}

/** The timeline of frames and soundtrack windows, indexed in the order {@link commitVideo} writes them. */
function timeline(
  size: { width: number; height: number },
  durationMs: number,
  sampling: VideoSampling,
  frames: readonly { tMs: number }[],
  soundtrack: readonly { startMs: number; endMs: number }[],
): VideoMeta {
  return {
    width: size.width,
    height: size.height,
    durationMs,
    frames: frames.map((f, i) => ({ tMs: f.tMs, frame: i })),
    poster: 0,
    sampling: { ...sampling },
    ...(soundtrack.length > 0
      ? { soundtrack: soundtrack.map((w, i) => ({ startMs: w.startMs, endMs: w.endMs, audio: frames.length + i })) }
      : {}),
  };
}

/**
 * Write a video manifest: its frames' and windows' representations as given,
 * the transcript beside them, the timeline as config. A timeline that would
 * not read back is refused before anything is written.
 */
function commitVideo(
  store: AttachmentStore, caller: string, meta: VideoMeta, media: readonly Descriptor[], transcript?: Transcript, source?: Descriptor,
): Attachment {
  if (!asVideoMeta(meta)) throw new Error(`${caller}: the timeline is not well formed`);
  const enc = new TextEncoder();
  const transcriptRep = transcript
    ? [store.putBlob(enc.encode(JSON.stringify(transcript)), TRANSCRIPT_MEDIA_TYPE)]
    : [];
  return store.putAttachment({
    representations: [...media, ...transcriptRep],
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

/**
 * A transcript segment as the model reads it, placed at the end of its window,
 * or at the first frame for speech heard before the picture starts.
 */
const noteOf = (firstFrameMs: number) => (segment: Transcript['segments'][number]): { atMs: number; text: string } =>
  ({ atMs: Math.max(segment.endMs, firstFrameMs), text: ` Speech: "${segment.text}"` });

/**
 * Resolve a video root to the input the projector takes, every blob verified.
 *
 * @throws {ContentLost} If the video, any frame, the transcript or the
 *         timeline is missing or has drifted from its digest.
 * @throws If the root is a stored attachment that is not a video.
 *
 * @category Media
 */
export function resolveVideo(store: AttachmentStore, root: Attachment): VideoInput {
  const { meta, reps, transcript, read } = storedVideo(store, root, 'resolveVideo');
  const notes = transcript?.segments.filter(s => s.text.trim().length > 0).map(noteOf(meta.frames[0].tMs)) ?? [];
  return {
    kind: 'video',
    frames: meta.frames.map(f => read(reps[f.frame], 'frame')),
    timestampsMs: meta.frames.map(f => f.tMs),
    timestampIntervalMs: meta.sampling.timestampIntervalMs,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/**
 * A stored video's soundtrack, window by window in time order, each admitted as a recording under `limits`: what
 * a consumer that hears is given beside the frames. Empty for a video kept without one.
 *
 * @throws {ContentLost} If a window's recording is missing or has drifted from its digest.
 * @throws If a window is not a recording these limits admit.
 *
 * @category Media
 */
export function resolveSoundtrack(store: AttachmentStore, root: Attachment, limits: Partial<AudioAdmission> = {}): Uint8Array[] {
  const { meta, reps, read } = storedVideo(store, root, 'resolveSoundtrack');
  return (meta.soundtrack ?? []).map(w => {
    const bytes = read(reps[w.audio], 'soundtrack window');
    inspectPcmWav(bytes, limits);
    return bytes;
  });
}

/** A stored video read back, every blob it is read from verified: its manifest, timeline, representations and transcript. */
function storedVideo(store: AttachmentStore, root: Attachment, caller: string) {
  const manifest = store.getManifest(root.digest);
  if (!manifest) throw new ContentLost(`video ${root.digest.slice(0, 19)}… is not in the content store, or its bytes no longer hash to its digest`);
  if (manifest.config.mediaType !== VIDEO_CONFIG_TYPE) {
    throw new Error(`${caller}: ${root.digest.slice(0, 19)}… is not a video in this store`);
  }
  const read = (d: Descriptor, what: string): Uint8Array => {
    const bytes = store.get(d.digest);
    if (!bytes) throw new ContentLost(`the ${what} ${d.digest.slice(0, 19)}… is missing or no longer hashes to its digest`);
    return bytes;
  };
  const meta = asVideoMeta(JSON.parse(new TextDecoder().decode(read(manifest.config, 'timeline'))));
  if (!meta) throw new Error(`${caller}: the video timeline is not well formed`);
  const reps = representationsOf(manifest);
  const transcriptRep = reps.find(r => r.mediaType === TRANSCRIPT_MEDIA_TYPE);
  const transcript = transcriptRep
    ? asTranscript(JSON.parse(new TextDecoder().decode(read(transcriptRep, 'transcript'))))
    : null;
  if (transcriptRep && !transcript) throw new Error(`${caller}: the stored transcript is not well formed`);
  meta.frames.forEach(f => {
    if (!PROJECTOR_FORMATS.includes(reps[f.frame]?.mediaType)) throw new Error(`${caller}: frame ${f.frame} is not an image`);
  });
  meta.soundtrack?.forEach(w => {
    if (reps[w.audio]?.mediaType !== AUDIO_MEDIA_TYPE) throw new Error(`${caller}: soundtrack representation ${w.audio} is not a recording`);
  });
  return { manifest, meta, reps, transcript, read };
}

/**
 * A span of a stored video, as a video of its own: the frames that fall in it,
 * the soundtrack windows and transcript segments that overlap it, all at the
 * video's own times, so a model reading the window cites the moments the
 * video plays. The frames' and recordings' blobs and the original are reused;
 * only the window's timeline and its share of the transcript are written.
 *
 * @throws {ContentLost} If the video or what it is read from is gone.
 * @throws If the root is not a video, or the span is empty or holds no frame.
 *
 * @category Media
 */
export function videoWindow(store: AttachmentStore, root: Attachment, span: { fromMs: number; toMs: number }): Attachment {
  const { fromMs, toMs } = span;
  if (!isMs(fromMs) || !isMs(toMs)) throw new Error('videoWindow: the span is two times in whole milliseconds');
  if (fromMs > toMs) throw new Error('videoWindow: the span ends before it starts');
  const { manifest, meta, reps, transcript } = storedVideo(store, root, 'videoWindow');
  const overlaps = (s: { startMs: number; endMs: number }): boolean => s.startMs < toMs && s.endMs > fromMs;
  const frames = meta.frames.filter(f => f.tMs >= fromMs && f.tMs <= toMs);
  if (frames.length === 0) throw new Error(`videoWindow: no frame of this video falls between ${fromMs} and ${toMs} ms`);
  const soundtrack = (meta.soundtrack ?? []).filter(overlaps);
  const said = transcript?.segments.filter(overlaps) ?? [];
  return commitVideo(
    store,
    'videoWindow',
    timeline(meta, meta.durationMs, meta.sampling, frames, soundtrack),
    [...frames.map(f => reps[f.frame]), ...soundtrack.map(w => reps[w.audio])],
    transcript && said.length > 0 ? { provenance: transcript.provenance, segments: said } : undefined,
    sourceOf(manifest),
  );
}

/** A length as a reader says it: tenths of a second under a minute, whole minutes and seconds past it. */
function spokenLength(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} s`;
  const seconds = Math.round(ms / 1000);
  const [minutes, rest] = [Math.floor(seconds / 60), seconds % 60];
  return rest > 0 ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/**
 * The sentence refusing a clip longer than a harness takes, if it is. The one
 * limit on a clip's length: the page asks it of the container's duration
 * before pushing any byte, and the host asks it again before transcribing.
 * Without a limit, a clip of any length is taken.
 *
 * @category Media
 */
export function durationRefusal(durationMs: number, maxDurationMs?: number): string | undefined {
  return maxDurationMs !== undefined && durationMs > maxDurationMs
    ? `This video runs ${spokenLength(durationMs)}; this harness takes videos up to ${spokenLength(maxDurationMs)}.`
    : undefined;
}

/** Whether these leading bytes are a video container the single-payload ingress refuses. */
export const isVideoContainer = (bytes: Uint8Array): boolean => VIDEO_CONTAINER_TYPES.includes(sniffMediaType(bytes));
