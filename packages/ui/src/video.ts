/**
 * A video, attached from the page: decoded here, composed by the host.
 *
 * The page is where a clip can be decoded — the browser's own WebCodecs, with
 * Mediabunny reading the container — so the page samples the frames the model
 * will see, cuts the soundtrack into windows for the transcription service,
 * and pushes the original as a blob. Each frame and window enters through the
 * content plane's ordinary ingress; one `video:compose` then asks the host to
 * make them one attachment. Bytes travel over HTTP, the socket carries
 * references, and the host authors the manifest.
 *
 * Browser-only below the pure helpers: it needs WebCodecs and a canvas.
 *
 * @category UI
 */
import { useEffect, useState } from 'react';
import { ALL_FORMATS, AudioBufferSink, BlobSource, CanvasSink, Input } from 'mediabunny';
import { ingestMedia, pushBlob } from '@lloyal-labs/media';
import type { Attachment, Descriptor } from '@lloyal-labs/media';
import type { UntranscribedWindow, VideoCapabilities, VideoCommand, VideoEvent, VideoFrameRef, VideoAudioRef } from '@lloyal-labs/binding';
import { useAvailability, useContentOrigin, useHarness } from './provider.js';

type Sampling = VideoCapabilities['sampling'];

// ── Pure: what to sample, and how a soundtrack is cut ────────────────────────

/**
 * The times to sample, in seconds from the clip's first frame: `fps` apart, or
 * spread evenly when the clip is longer than `maxFrames` allows at that rate.
 */
export function frameTimes(durationS: number, sampling: Pick<Sampling, 'fps' | 'maxFrames'>): number[] {
  const atRate = Math.max(1, Math.floor(durationS * sampling.fps));
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
export class SoundtrackCutter {
  private pending = new Float32Array(0);
  private startSample = 0;
  private readonly window: number;
  private readonly slack: number;

  constructor(private readonly rate: number, windowMs: number) {
    this.window = Math.round(rate * windowMs / 1000);
    this.slack = Math.round(this.window / 5);
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
 * @throws If the file has no video track this browser can decode.
 */
export async function sampleVideo(file: Blob, sampling: Sampling): Promise<{ frames: SampledFrame[]; durationMs: number }> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('This browser cannot decode the video in that file.');
    const first = await track.getFirstTimestamp();
    const durationS = (await input.computeDuration()) - first;
    const size = fitEdge(track.displayWidth, track.displayHeight, sampling.maxEdgePx);
    const sink = new CanvasSink(track, { ...size, fit: 'fill' });
    const frames: SampledFrame[] = [];
    for await (const wrapped of sink.canvasesAtTimestamps(frameTimes(durationS, sampling).map(t => first + t))) {
      if (!wrapped) continue;
      const tMs = Math.round((wrapped.timestamp - first) * 1000);
      // A sparse source repeats a frame for nearby sample times; each frame is kept once.
      if (frames.length > 0 && tMs <= frames[frames.length - 1].tMs) continue;
      frames.push({ bytes: await jpeg(wrapped.canvas), tMs });
    }
    if (frames.length === 0) throw new Error('No frames could be read from that video.');
    return { frames, durationMs: Math.round(durationS * 1000) };
  } finally {
    input.dispose();
  }
}

/** The highest rate the transcription service admits; higher sources are decimated to it. */
const MAX_WINDOW_RATE = 48_000;

/**
 * The clip's soundtrack as mono windows of about `windowMs`, decoded with the
 * browser's own audio decoder and cut at quiet points. Yields nothing for a
 * file without an audio track it can decode.
 */
export async function* extractAudioWindows(file: Blob, windowMs: number): AsyncGenerator<SoundtrackWindow> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return;
    let cutter: SoundtrackCutter | null = null;
    let step = 1;
    for await (const { buffer } of new AudioBufferSink(track).buffers()) {
      step = Math.ceil(buffer.sampleRate / MAX_WINDOW_RATE);
      cutter ??= new SoundtrackCutter(buffer.sampleRate / step, windowMs);
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
      const mono = new Float32Array(Math.floor(buffer.length / step));
      for (let i = 0; i < mono.length; i++) {
        let sum = 0;
        for (const channel of channels) sum += channel[i * step];
        mono[i] = sum / channels.length;
      }
      yield* cutter.push(mono);
    }
    if (cutter) yield* cutter.flush();
  } finally {
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
  try {
    while (!policy.signal?.aborted) {
      const { value: frame, done } = await reader.read();
      if (done || !frame) break;
      try {
        first ??= frame.timestamp;
        if (frame.timestamp - first < next) continue;
        next += interval;
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
    await reader.cancel().catch(() => {});
  }
}

// ── Composing on the host ────────────────────────────────────────────────────

/** Where an attach is: what the attach row says while it works. */
export type VideoProgress =
  | { phase: 'uploading'; done: number; total: number }
  | { phase: 'sampling' }
  | { phase: 'ingesting'; done: number; total: number }
  | { phase: 'transcribing'; done: number; total: number }
  | { phase: 'composing' };

export interface AttachedVideo {
  root: Attachment;
  /** Soundtrack windows the host could not transcribe; the video carries the rest. */
  untranscribed: UntranscribedWindow[];
}

/**
 * Attach one video file: push the original, sample and ingest its frames and
 * soundtrack windows, and have the host compose them. Resolves to the composed
 * root, ready to send with a message like any other attachment.
 */
export async function ingestVideo(opts: {
  origin: string;
  /** Any harness bridge: it carries the app's whole event union, of which the video events are part. */
  bridge: { onEvent(cb: (frame: { ev: { type: string } }) => void): () => void; send(command: VideoCommand): void };
  file: Blob;
  /** What the host said it composes under; asked for here when the caller has not heard yet. */
  capabilities?: VideoCapabilities | null;
  signal?: AbortSignal;
  onProgress?: (progress: VideoProgress) => void;
}): Promise<AttachedVideo> {
  const { origin, bridge, file, signal, onProgress } = opts;
  const capabilities = opts.capabilities ?? await describe(bridge, signal);
  const { sampling } = capabilities;
  const source: Descriptor = await pushBlob(origin, file, {
    ...(signal ? { signal } : {}),
    onProgress: (done, total) => onProgress?.({ phase: 'uploading', done, total }),
  });
  onProgress?.({ phase: 'sampling' });
  const sampled = await sampleVideo(file, sampling);
  const frames: VideoFrameRef[] = [];
  for (const [i, frame] of sampled.frames.entries()) {
    frames.push({ root: await ingestMedia(origin, frame.bytes, { ...(signal ? { signal } : {}) }), tMs: frame.tMs });
    onProgress?.({ phase: 'ingesting', done: i + 1, total: sampled.frames.length });
  }
  const audio: VideoAudioRef[] = [];
  if (capabilities.transcription) {
    for await (const window of extractAudioWindows(file, sampling.timestampIntervalMs)) {
      audio.push({ root: await ingestMedia(origin, window.bytes, { ...(signal ? { signal } : {}) }), startMs: window.startMs, endMs: window.endMs });
    }
  }
  signal?.throwIfAborted();

  const requestId = crypto.randomUUID();
  onProgress?.({ phase: 'composing' });
  return new Promise<AttachedVideo>((resolve, reject) => {
    const stop = bridge.onEvent(({ ev: event }) => {
      if (!isVideoEvent(event) || !('requestId' in event) || event.requestId !== requestId) return;
      const ev = event;
      if (ev.type === 'video:progress') onProgress?.({ phase: 'transcribing', done: ev.done, total: ev.total });
      if (ev.type === 'video:composed') { stop(); resolve({ root: ev.root, untranscribed: ev.untranscribed }); }
      if (ev.type === 'video:error') { stop(); reject(new Error(ev.message)); }
      if (ev.type === 'video:cancelled') { stop(); reject(new DOMException('The video was cancelled.', 'AbortError')); }
    });
    signal?.addEventListener('abort', () => bridge.send({ type: 'video:cancel', requestId }), { once: true });
    bridge.send({
      type: 'video:compose', requestId, frames, sampling: { fps: sampling.fps, timestampIntervalMs: sampling.timestampIntervalMs, maxFrames: sampling.maxFrames },
      durationMs: Math.max(sampled.durationMs, frames[frames.length - 1].tMs),
      ...(audio.length > 0 ? { audio } : {}), source,
    });
  });
}

const isVideoEvent = (ev: { type: string }): ev is VideoEvent => ev.type.startsWith('video:');

/** Ask the host how it composes a video, and wait for the answer. */
function describe(bridge: Parameters<typeof ingestVideo>[0]['bridge'], signal?: AbortSignal): Promise<VideoCapabilities> {
  return new Promise((resolve, reject) => {
    const stop = bridge.onEvent(({ ev }) => {
      if (isVideoEvent(ev) && ev.type === 'video:capabilities') { stop(); resolve(ev.capabilities); }
    });
    signal?.addEventListener('abort', () => { stop(); reject(signal.reason); }, { once: true });
    bridge.send({ type: 'video:describe' });
  });
}

/**
 * The host's video capabilities, asked for once the harness is ready; null
 * until it answers. A composer offers video only once this is known.
 */
export function useVideoCapabilities(): VideoCapabilities | null {
  const { bridge } = useHarness<VideoEvent, VideoCommand>();
  const availability = useAvailability();
  const origin = useContentOrigin();
  const [capabilities, setCapabilities] = useState<VideoCapabilities | null>(null);
  useEffect(() => {
    setCapabilities(null);
    if (availability !== 'ready' || origin === null) return;
    const stop = bridge.onEvent(({ ev }) => { if (ev.type === 'video:capabilities') setCapabilities(ev.capabilities); });
    bridge.send({ type: 'video:describe' });
    return stop;
  }, [bridge, availability, origin]);
  return capabilities;
}
