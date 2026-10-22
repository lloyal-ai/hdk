/**
 * Reading a clip: the frames a model will see and the soundtrack a
 * transcription service will hear, through whichever decoder reads the file.
 *
 * The procedure is written once, against {@link ClipDecoder}: what to sample,
 * how each frame is stamped, how the sound is mixed, decimated, placed and cut,
 * and what a compose is sent. A decoder only opens the file and hands over
 * pictures and sound. The page's decoder is Mediabunny over WebCodecs
 * (`mediabunnyDecoder` in `@lloyal-labs/media/client`); another runtime swaps
 * in its own, and what it produces is what the page produces.
 *
 * Browser-safe, with no dependency: decoders bring their own.
 *
 * @category Media
 */
import type { Descriptor } from './attachment';
import type { AudioAdmission } from './audio';
import { markInterval } from './video';
import type { VideoSampling } from './video';

// ── The decoder contract ─────────────────────────────────────────────────────

/** A picture as a decoder showed it: when, on the file's clock, and the frame encoded as a video frame. */
export interface ShownFrame {
  /** The time this frame is shown from, in seconds on the file's own clock. */
  shownS: number;
  /** The frame at the size asked for, encoded as JPEG at the frame quality (canvas `0.85`, `encodeVideoFrame` on a host). */
  bytes: Uint8Array;
}

/** A run of decoded sound: when it plays, on the file's clock, its rate and its samples per channel. */
export interface DecodedSound {
  shownS: number;
  sampleRate: number;
  channels: Float32Array[];
}

/**
 * What a decoder does with one file, and all it does: the procedure that
 * samples, stamps, mixes and cuts is this module's, the same for every decoder.
 *
 * - `frames` yields, for each time asked, the frame shown at that time (the
 *   last one whose presentation time is at or before it), or `null` where
 *   nothing is shown. Times are in order.
 * - `sound` yields the decoded sound in presentation order, each run at its
 *   own time; gaps between runs are silence. A file with no sound the decoder
 *   can read yields nothing.
 * - `dispose` stops the decoder: a read still waiting rejects, and nothing
 *   further is decoded. It may be called more than once.
 */
export interface ClipDecoder {
  /** Where the clip ends on its own clock, in seconds. */
  duration(): Promise<number>;
  /** The picture's display size and the time its first frame is shown. Rejects, naming why, when there is no picture this decoder can read. */
  picture(): Promise<{ width: number; height: number; startS: number }>;
  frames(timesS: number[], size: { width: number; height: number }): AsyncIterable<ShownFrame | null>;
  sound(): AsyncIterable<DecodedSound>;
  dispose(): void;
}

// ── Pure: what to sample, and how a soundtrack is cut ────────────────────────

/**
 * The times to sample, in seconds from the picture's first frame: `fps` apart, or
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

/** The highest rate a window is written at, unless the transcription service admits less; higher sources are decimated. */
const MAX_WINDOW_RATE = 48_000;
/** A PCM WAV header's bytes, ahead of its samples. */
const WAV_HEADER_BYTES = 44;
/** How far past its nominal length the cutter may end a window: a fifth, its search slack. */
const CUT_SLACK = 1 / 5;

/** The fastest a soundtrack is written: 48 kHz, or the rate the transcription service admits if that is less. */
const soundtrackCeiling = (maxSampleRate = MAX_WINDOW_RATE): number => Math.min(MAX_WINDOW_RATE, maxSampleRate);

/**
 * The rate a soundtrack is written at: every `step`th sample of a source at
 * `sourceRate`, the smallest step that keeps it within the ceiling.
 */
export function soundtrackDecimation(sourceRate: number, maxSampleRate?: number): { step: number; rate: number } {
  const step = Math.ceil(sourceRate / soundtrackCeiling(maxSampleRate));
  return { step, rate: sourceRate / step };
}

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
  const rate = soundtrackCeiling(limits.maxSampleRate);
  const admitted = Math.min(limits.maxDurationSeconds * 1000, ((limits.maxBytes - WAV_HEADER_BYTES) / 2 / rate) * 1000);
  return Math.max(1, Math.floor(Math.min(wanted, admitted / (1 + CUT_SLACK))));
}

/** A clip's length in whole milliseconds: the one clock its frames, its soundtrack and its composition share. */
export const clipDurationMs = (endS: number): number => Math.round(endS * 1000);

/** The soundtrack sample at the clip's end, at `rate`: never past {@link clipDurationMs}, so no window ends after it. */
export const clipEndSample = (endS: number, rate: number): number => Math.floor(clipDurationMs(endS) * rate / 1000);

/**
 * Cut a mono stream into windows of about `windowMs`, each ending at a quiet
 * point near its nominal end, with no overlaps and no gaps — the rule the
 * Qwen3-ASR toolkit uses to split long audio. Fed chunk by chunk, so only
 * about two windows of samples are held at once.
 */
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

// ── The procedure, through any decoder ───────────────────────────────────────

/** One sampled frame: an encoded image and when it was shown. */
export interface SampledFrame { bytes: Uint8Array; tMs: number }

/** Stop `decoder` when `signal` aborts, so a read still waiting rejects at once; returns the undo. */
function stopOnAbort(decoder: ClipDecoder, signal: AbortSignal | undefined): () => void {
  signal?.throwIfAborted();
  const stop = (): void => decoder.dispose();
  signal?.addEventListener('abort', stop, { once: true });
  return () => signal?.removeEventListener('abort', stop);
}

/**
 * Sample a clip's frames the way the host will compose them: at the policy's
 * rate, capped in count and edge length, each frame stamped with the time it
 * was actually shown.
 *
 * Times are on the file's own clock, from zero, the clock a player seeks on:
 * a picture that starts after its sound has its first frame at that later
 * time, so a frame, a caption or a cited moment plays where the model saw it.
 *
 * @throws If the decoder reads no picture or no frame, or with the signal's
 *         reason once it aborts; no further frame is decoded.
 */
export async function sampleFrames(
  decoder: ClipDecoder,
  sampling: VideoSampling & { maxEdgePx: number },
  options: { signal?: AbortSignal } = {},
): Promise<{ frames: SampledFrame[]; durationMs: number }> {
  const { signal } = options;
  const release = stopOnAbort(decoder, signal);
  try {
    const picture = await decoder.picture();
    // A picture that starts before zero (an edit list's lead-in) is shown from zero, as a player shows it.
    const first = Math.max(0, picture.startS);
    const endS = await decoder.duration();
    const size = fitEdge(picture.width, picture.height, sampling.maxEdgePx);
    const frames: SampledFrame[] = [];
    for await (const shown of decoder.frames(frameTimes(endS - first, sampling).map(t => first + t), size)) {
      signal?.throwIfAborted();
      if (!shown) continue;
      const tMs = Math.max(0, Math.round(shown.shownS * 1000));
      // A sparse source repeats a frame for nearby sample times; each frame is kept once.
      if (frames.length > 0 && tMs <= frames[frames.length - 1].tMs) continue;
      frames.push({ bytes: shown.bytes, tMs });
    }
    if (frames.length === 0) throw new Error('No frames could be read from that video.');
    return { frames, durationMs: clipDurationMs(endS) };
  } catch (e) {
    // A disposed decoder fails its read with its own error; the caller asked to stop, so it hears why.
    signal?.throwIfAborted();
    throw e;
  } finally {
    release();
  }
}

/** Mono samples of one decoded run, decimated by `step`. */
function mixDown(channels: Float32Array[], step: number): Float32Array {
  const mono = new Float32Array(Math.floor((channels[0]?.length ?? 0) / step));
  for (let i = 0; i < mono.length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i * step];
    mono[i] = sum / channels.length;
  }
  return mono;
}

/**
 * The clip's soundtrack as mono windows of about `windowMs`, cut at quiet
 * points, written no faster than the transcription service admits. Yields
 * nothing for a clip without sound the decoder can read.
 *
 * Windows are timed on the file's own clock, the one {@link sampleFrames}
 * stamps frames on: sound that starts late, or pauses, is placed by its own
 * time, the gaps filled with silence, and sound before zero or past the clip's
 * end (a codec's priming and padding) is left out.
 *
 * @throws With the signal's reason once it aborts: the decoder is disposed
 *         then, so a decode still in flight stops rather than running to the end.
 */
export async function* soundtrackWindows(
  decoder: ClipDecoder,
  windowMs: number,
  options: { signal?: AbortSignal; maxSampleRate?: number } = {},
): AsyncGenerator<SoundtrackWindow> {
  const { signal } = options;
  const release = stopOnAbort(decoder, signal);
  try {
    // The clip ends where sampleFrames says it does; decoded sound past it is the codec's padding.
    const endsAtS = await decoder.duration();
    let cutter: SoundtrackCutter | null = null;
    let rate = 0;
    let fed = 0;   // samples given to the cutter: the clip time it has reached
    for await (const run of decoder.sound()) {
      signal?.throwIfAborted();
      const { step, rate: written } = soundtrackDecimation(run.sampleRate, options.maxSampleRate);
      rate ||= written;
      cutter ??= new SoundtrackCutter(rate, windowMs);
      const end = clipEndSample(endsAtS, rate);
      const startsAt = Math.min(Math.round(run.shownS * rate), end);
      for (let gap = startsAt - fed; gap > 0; gap -= rate) {
        const silence = new Float32Array(Math.min(gap, rate));
        fed += silence.length;
        yield* cutter.push(silence);
      }
      const mono = mixDown(run.channels, step).subarray(Math.max(0, fed - startsAt), Math.max(0, end - startsAt));
      fed += mono.length;
      yield* cutter.push(mono);
      if (fed >= end) break;
    }
    if (cutter) yield* cutter.flush();
  } catch (e) {
    // A disposed decoder fails its read with its own error; the caller asked to stop, so it hears why.
    signal?.throwIfAborted();
    throw e;
  } finally {
    release();
  }
}

/** Where preparing a video is, for a caller to show. */
export type PrepareProgress = { phase: 'sampling' } | { phase: 'ingesting'; done: number; total: number };

/** What a compose is sent: the frames and soundtrack windows as references to what was ingested (the host checks each), and the clip's length. */
export interface PreparedVideo {
  frames: { root: Descriptor; tMs: number }[];
  audio: { root: Descriptor; startMs: number; endMs: number }[];
  durationMs: number;
}

/**
 * Read a clip under the host's policy and ingest what a compose needs: every
 * sampled frame, and when the host transcribes, every soundtrack window, cut
 * at the mark interval the frames will be recorded with and sized to what the
 * transcription service admits. The page does this with its decoder and its
 * upload; a host or a tool does it with its own, and sends the same compose.
 *
 * The decoder is the caller's: this neither opens nor disposes it, except to
 * stop it on abort.
 */
export async function prepareVideo(
  decoder: ClipDecoder,
  policy: {
    sampling: VideoSampling & { maxEdgePx: number };
    transcription: Pick<AudioAdmission, 'maxBytes' | 'maxDurationSeconds' | 'maxSampleRate'> | null;
  },
  ingest: (bytes: Uint8Array) => Promise<Descriptor>,
  options: { signal?: AbortSignal; onProgress?: (progress: PrepareProgress) => void } = {},
): Promise<PreparedVideo> {
  const { signal, onProgress } = options;
  onProgress?.({ phase: 'sampling' });
  const sampled = await sampleFrames(decoder, policy.sampling, { ...(signal ? { signal } : {}) });
  const frames: PreparedVideo['frames'] = [];
  for (const [i, frame] of sampled.frames.entries()) {
    frames.push({ root: await ingest(frame.bytes), tMs: frame.tMs });
    onProgress?.({ phase: 'ingesting', done: i + 1, total: sampled.frames.length });
  }
  const audio: PreparedVideo['audio'] = [];
  if (policy.transcription) {
    const marks = { timestampIntervalMs: markInterval(sampled.frames.map(f => f.tMs), policy.sampling) };
    const windows = soundtrackWindows(decoder, soundtrackWindowMs(marks, policy.transcription), {
      ...(signal ? { signal } : {}), maxSampleRate: policy.transcription.maxSampleRate,
    });
    for await (const window of windows) audio.push({ root: await ingest(window.bytes), startMs: window.startMs, endMs: window.endMs });
  }
  return { frames, audio, durationMs: Math.max(sampled.durationMs, frames[frames.length - 1].tMs) };
}
