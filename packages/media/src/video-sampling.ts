/**
 * Video, read in the page: the frames a model will see and the soundtrack a
 * transcription service will hear.
 *
 * Only a page can decode video here — the browser's WebCodecs, with Mediabunny
 * reading the container — so this is where a clip is sampled, its frames sized
 * and encoded, and its soundtrack cut into windows. What leaves is ordinary
 * content: JPEG frames and PCM WAV windows that the content plane's ingress
 * admits like any other image or recording.
 *
 * Browser-only below the pure helpers: it needs WebCodecs and a canvas.
 * `mediabunny` is an OPTIONAL peer, needed only by this entry.
 *
 * @category Media
 */
import { ALL_FORMATS, AudioBufferSink, BlobSource, CanvasSink, Input } from 'mediabunny';
import type { VideoSampling } from './video';
import type { AudioAdmission } from './audio';

// ── Pure: what to sample, and how a soundtrack is cut ────────────────────────

/**
 * The times to sample, in seconds from the clip's first frame: `fps` apart, or
 * spread evenly when the clip is longer than `maxFrames` allows at that rate.
 */
export function frameTimes(durationS: number, sampling: Pick<VideoSampling, 'fps' | 'maxFrames'>): number[] {
  // Each instant before the clip ends; the epsilon keeps float noise from adding one at the very end.
  const atRate = Math.max(1, Math.ceil(durationS * sampling.fps - 1e-9));
  const n = Math.min(sampling.maxFrames, atRate);
  const step = n === atRate ? 1 / sampling.fps : durationS / n;
  return Array.from({ length: n }, (_, i) => i * step);
}

/** A frame size whose longest edge is at most `maxEdge`, keeping the aspect. Never upscales. */
export function fitEdge(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** RMS energy frames this long decide where a window may be cut. */
const ENERGY_FRAME_MS = 20;

/**
 * Where to end a window that should end near `target`: the quietest
 * {@link ENERGY_FRAME_MS} frame within `slack` samples of it, so a cut falls
 * between words rather than through one.
 */
export function quietestCut(samples: Float32Array, rate: number, target: number, slack: number): number {
  const frame = Math.max(1, Math.round(rate * ENERGY_FRAME_MS / 1000));
  let best = target;
  let bestEnergy = Infinity;
  for (let at = Math.max(frame, target - slack); at + frame <= Math.min(samples.length, target + slack); at += frame) {
    let energy = 0;
    for (let i = at - frame; i < at; i++) energy += samples[i] * samples[i];
    if (energy < bestEnergy) { bestEnergy = energy; best = at; }
  }
  return best;
}

/** Mono PCM16 WAV of these samples, which the transcription service admits. */
export function pcm16Wav(samples: Float32Array, rate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, s: string): void => { for (let i = 0; i < 4; i++) bytes[at + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(s * 32767))), true));
  return bytes;
}

/** One soundtrack window, ready for the content plane. */
export interface SoundtrackWindow { bytes: Uint8Array; startMs: number; endMs: number }

/**
 * Cut a mono stream into windows of about `windowMs`, each ending at a quiet
 * point near its nominal end, with no overlaps and no gaps — the rule the
 * Qwen3-ASR toolkit uses to split long audio. Fed chunk by chunk, so only
 * about two windows of samples are held at once.
 */
/** The highest rate a window is written at, unless the transcription service admits less; higher sources are decimated. */
const MAX_WINDOW_RATE = 48_000;
/** A PCM WAV header's bytes, ahead of its samples. */
const WAV_HEADER_BYTES = 44;
/** How far past its nominal length the cutter may end a window: a fifth, its search slack. */
const CUT_SLACK = 1 / 5;

/**
 * How long each soundtrack window runs: the timestamp interval, so a window's
 * words join the timestamp that closes it, or 5 s when timestamps are off. A
 * transcription service's limits cap it, with room for the cutter, which may
 * end a window up to a fifth past its nominal length: within the duration the
 * service admits, and within its bytes as mono PCM16 at the rate written.
 */
export function soundtrackWindowMs(
  sampling: Pick<VideoSampling, 'timestampIntervalMs'>,
  limits?: Pick<AudioAdmission, 'maxBytes' | 'maxDurationSeconds' | 'maxSampleRate'>,
): number {
  const wanted = sampling.timestampIntervalMs > 0 ? sampling.timestampIntervalMs : 5000;
  if (!limits) return wanted;
  const rate = Math.min(MAX_WINDOW_RATE, limits.maxSampleRate);
  const admitted = Math.min(limits.maxDurationSeconds * 1000, ((limits.maxBytes - WAV_HEADER_BYTES) / 2 / rate) * 1000);
  return Math.max(1, Math.floor(Math.min(wanted, admitted / (1 + CUT_SLACK))));
}

export class SoundtrackCutter {
  private pending = new Float32Array(0);
  private startSample = 0;
  private readonly window: number;
  private readonly slack: number;

  constructor(private readonly rate: number, windowMs: number) {
    if (!(windowMs > 0)) throw new RangeError(`a soundtrack window must be longer than 0 ms, not ${windowMs}`);
    this.window = Math.round(rate * windowMs / 1000);
    this.slack = Math.round(this.window * CUT_SLACK);
  }

  /** Add samples; returns the windows they complete. */
  push(samples: Float32Array): SoundtrackWindow[] {
    const joined = new Float32Array(this.pending.length + samples.length);
    joined.set(this.pending);
    joined.set(samples, this.pending.length);
    this.pending = joined;
    const out: SoundtrackWindow[] = [];
    while (this.pending.length >= this.window + this.slack) {
      out.push(this.emit(quietestCut(this.pending, this.rate, this.window, this.slack)));
    }
    return out;
  }

  /** The last, shorter window, if any samples remain. */
  flush(): SoundtrackWindow[] {
    return this.pending.length >= 2 ? [this.emit(this.pending.length)] : [];
  }

  private emit(cut: number): SoundtrackWindow {
    const ms = (sample: number): number => Math.round(sample * 1000 / this.rate);
    const window = { bytes: pcm16Wav(this.pending.subarray(0, cut), this.rate), startMs: ms(this.startSample), endMs: ms(this.startSample + cut) };
    this.startSample += cut;
    this.pending = this.pending.slice(cut);
    return window;
  }
}

// ── Browser: decode, sample, capture ─────────────────────────────────────────

/** One sampled frame: an encoded image and when it was shown. */
export interface SampledFrame { bytes: Uint8Array; tMs: number }

const JPEG_QUALITY = 0.85;

async function jpeg(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Uint8Array> {
  const blob = 'convertToBlob' in canvas
    ? await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
    : await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('the frame could not be encoded'))), 'image/jpeg', JPEG_QUALITY));
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Sample a clip's frames the way the host will compose them: at the policy's
 * rate, capped in count and edge length, each frame stamped with the time it
 * was actually shown.
 *
 * @throws If the file has no video track this browser can decode, or with
 *         the signal's reason once it aborts; no further frame is decoded.
 */
export async function sampleVideo(
  file: Blob,
  sampling: VideoSampling & { maxEdgePx: number },
  options: { signal?: AbortSignal } = {},
): Promise<{ frames: SampledFrame[]; durationMs: number }> {
  const { signal } = options;
  signal?.throwIfAborted();
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  // Disposing rejects a decode still waiting, so an abort never waits for the next frame.
  const stop = (): void => input.dispose();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('This browser cannot decode the video in that file.');
    const first = await track.getFirstTimestamp();
    const durationS = (await input.computeDuration()) - first;
    const size = fitEdge(track.displayWidth, track.displayHeight, sampling.maxEdgePx);
    const sink = new CanvasSink(track, { ...size, fit: 'fill' });
    const frames: SampledFrame[] = [];
    for await (const wrapped of sink.canvasesAtTimestamps(frameTimes(durationS, sampling).map(t => first + t))) {
      signal?.throwIfAborted();
      if (!wrapped) continue;
      const tMs = Math.round((wrapped.timestamp - first) * 1000);
      // A sparse source repeats a frame for nearby sample times; each frame is kept once.
      if (frames.length > 0 && tMs <= frames[frames.length - 1].tMs) continue;
      frames.push({ bytes: await jpeg(wrapped.canvas), tMs });
    }
    if (frames.length === 0) throw new Error('No frames could be read from that video.');
    return { frames, durationMs: Math.round(durationS * 1000) };
  } catch (e) {
    // A disposed input fails its read with its own error; the caller asked to stop, so it hears why.
    signal?.throwIfAborted();
    throw e;
  } finally {
    signal?.removeEventListener('abort', stop);
    input.dispose();
  }
}


/** Mono samples of one decoded buffer, decimated by `step`. */
function mixDown(buffer: AudioBuffer, step: number): Float32Array {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const mono = new Float32Array(Math.floor(buffer.length / step));
  for (let i = 0; i < mono.length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i * step];
    mono[i] = sum / channels.length;
  }
  return mono;
}

/**
 * The clip's soundtrack as mono windows of about `windowMs`, decoded with the
 * browser's own audio decoder and cut at quiet points. Yields nothing for a
 * file without an audio track it can decode.
 *
 * Windows are timed on the clip's clock, the one {@link sampleVideo} stamps
 * frames on (the video track's first timestamp is zero): sound that starts
 * late, or pauses, is placed by its own timestamps, the gaps filled with
 * silence, and sound before the first frame or past the clip's end (a
 * codec's padding) is left out.
 *
 * @throws With the signal's reason once it aborts: the input is disposed then,
 *         so a decode still in flight stops rather than running to the end.
 */
export async function* extractAudioWindows(
  file: Blob,
  windowMs: number,
  options: { signal?: AbortSignal; maxSampleRate?: number } = {},
): AsyncGenerator<SoundtrackWindow> {
  const { signal } = options;
  // Written no faster than the transcription service admits.
  const ceiling = Math.min(MAX_WINDOW_RATE, options.maxSampleRate ?? MAX_WINDOW_RATE);
  signal?.throwIfAborted();
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const stop = (): void => input.dispose();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return;
    const video = await input.getPrimaryVideoTrack();
    const origin = video ? await video.getFirstTimestamp() : await track.getFirstTimestamp();
    // The clip ends where sampleVideo says it does; decoded sound past it is the codec's padding.
    const endsAtS = (await input.computeDuration()) - origin;
    let cutter: SoundtrackCutter | null = null;
    let rate = 0;
    let fed = 0;   // samples given to the cutter: the clip time it has reached
    for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers()) {
      signal?.throwIfAborted();
      const step = Math.ceil(buffer.sampleRate / ceiling);
      rate ||= buffer.sampleRate / step;
      cutter ??= new SoundtrackCutter(rate, windowMs);
      const end = Math.round(endsAtS * rate);
      const startsAt = Math.min(Math.round((timestamp - origin) * rate), end);
      for (let gap = startsAt - fed; gap > 0; gap -= rate) {
        const silence = new Float32Array(Math.min(gap, rate));
        fed += silence.length;
        yield* cutter.push(silence);
      }
      const mono = mixDown(buffer, step).subarray(Math.max(0, fed - startsAt), Math.max(0, end - startsAt));
      fed += mono.length;
      yield* cutter.push(mono);
      if (fed >= end) break;
    }
    if (cutter) yield* cutter.flush();
  } catch (e) {
    // A disposed input fails its read with its own error; the caller asked to stop, so it hears why.
    signal?.throwIfAborted();
    throw e;
  } finally {
    signal?.removeEventListener('abort', stop);
    input.dispose();
  }
}

/**
 * The streaming seam: frames from a live track (a camera), in groups, each
 * group to be ingested and composed as one live capture with no source.
 *
 * @throws Where the browser cannot read frames from a track
 *         (`MediaStreamTrackProcessor` — Chromium and Electron have it).
 */
export async function* captureFrames(
  track: MediaStreamTrack,
  policy: { fps: number; groupSize: number; maxEdgePx: number; signal?: AbortSignal },
): AsyncGenerator<SampledFrame[]> {
  const Processor = (globalThis as { MediaStreamTrackProcessor?: new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } }).MediaStreamTrackProcessor;
  if (!Processor) throw new Error('This browser cannot read frames from a camera track.');
  const reader = new Processor({ track }).readable.getReader();
  const interval = 1_000_000 / policy.fps;
  let first: number | null = null;
  let next = 0;
  let group: SampledFrame[] = [];
  // Cancelling settles a read still waiting on the track, so an abort never waits for a frame.
  const stop = () => { reader.cancel().catch(() => {}); };
  policy.signal?.addEventListener('abort', stop, { once: true });
  try {
    while (!policy.signal?.aborted) {
      const { value: frame, done } = await reader.read();
      if (done || !frame) break;
      try {
        first ??= frame.timestamp;
        const elapsed = frame.timestamp - first;
        if (elapsed < next) continue;
        // The next sample time after this frame, so a late frame never lets a burst through behind it.
        next = (Math.floor(elapsed / interval) + 1) * interval;
        const size = fitEdge(frame.displayWidth, frame.displayHeight, policy.maxEdgePx);
        const canvas = new OffscreenCanvas(size.width, size.height);
        canvas.getContext('2d')!.drawImage(frame, 0, 0, size.width, size.height);
        group.push({ bytes: await jpeg(canvas), tMs: Math.round((frame.timestamp - first) / 1000) });
      } finally {
        frame.close();
      }
      if (group.length === policy.groupSize) { yield group; group = []; }
    }
    if (group.length > 0) yield group;
  } finally {
    policy.signal?.removeEventListener('abort', stop);
    await reader.cancel().catch(() => {});
  }
}
