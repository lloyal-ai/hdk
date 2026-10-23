/**
 * Video in the page: the browser's decoder for a clip, and a camera's frames.
 *
 * The page decodes with WebCodecs, Mediabunny reading the container. That is
 * one {@link ClipDecoder}; what is sampled, stamped, mixed and cut is the
 * decoder-independent procedure in `./clip`, so what leaves the page is what
 * any other decoder would produce: JPEG frames and PCM WAV windows that the
 * content plane's ingress admits like any other image or recording.
 *
 * Browser-only: it needs WebCodecs and a canvas. `mediabunny` is an OPTIONAL
 * peer, needed only by this entry.
 *
 * @category Media
 */
import { ALL_FORMATS, AudioBufferSink, BlobSource, CanvasSink, Input } from 'mediabunny';
import { FRAME_JPEG_QUALITY } from './video';
import type { VideoSampling } from './video';
import { clipDurationMs, fitEdge, sampleFrames, soundtrackWindows } from './clip';
import type { ClipDecoder, SampledFrame, SoundtrackWindow } from './clip';

async function jpeg(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Uint8Array> {
  const blob = 'convertToBlob' in canvas
    ? await canvas.convertToBlob({ type: 'image/jpeg', quality: FRAME_JPEG_QUALITY })
    : await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('the frame could not be encoded'))), 'image/jpeg', FRAME_JPEG_QUALITY));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Whether a decode failed because the platform's decoder refused the stream, rather than the file or the caller. */
const platformRefused = (e: unknown): boolean => e instanceof DOMException && e.name === 'EncodingError';

/**
 * The page's decoder: Mediabunny reading the file, WebCodecs decoding it.
 *
 * A platform decoder can refuse a stream partway that another decodes (macOS's
 * VideoToolbox rejects some H.264 frames as bad data, which Chrome raises as an
 * `EncodingError`), so frames it refuses are read on in software from where it
 * stopped.
 */
export function mediabunnyDecoder(file: Blob): ClipDecoder {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const readablePicture = async () => {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('This browser cannot decode the video in that file.');
    return track;
  };
  return {
    duration: () => input.computeDuration(),
    async picture() {
      const track = await readablePicture();
      return { width: track.displayWidth, height: track.displayHeight, startS: await track.getFirstTimestamp() };
    },
    async *frames(times, size) {
      const track = await readablePicture();
      let next = 0;
      for (const decoding of ['no-preference', 'prefer-software'] as const) {
        const sink = new CanvasSink(track, { ...size, fit: 'fill', decoderOptions: { hardwareAcceleration: decoding } });
        try {
          for await (const wrapped of sink.canvasesAtTimestamps(times.slice(next))) {
            next++;
            yield wrapped && { shownS: wrapped.timestamp, bytes: await jpeg(wrapped.canvas) };
          }
          return;
        } catch (e) {
          if (decoding === 'prefer-software' || !platformRefused(e)) throw e;
        }
      }
    },
    async *sound() {
      const track = await input.getPrimaryAudioTrack();
      if (!track || !(await track.canDecode())) return;
      for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers()) {
        yield {
          shownS: timestamp,
          sampleRate: buffer.sampleRate,
          channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)),
        };
      }
    },
    // Disposing rejects a decode still waiting, so an abort never waits for the next frame.
    dispose: () => input.dispose(),
  };
}

/**
 * Sample a clip's frames in the page, the way the host will compose them
 * ({@link sampleFrames} through {@link mediabunnyDecoder}).
 *
 * @throws If the file has no video track this browser can decode, or with
 *         the signal's reason once it aborts; no further frame is decoded.
 */
export async function sampleVideo(
  file: Blob,
  sampling: VideoSampling & { maxEdgePx: number },
  options: { signal?: AbortSignal } = {},
): Promise<{ frames: SampledFrame[]; durationMs: number }> {
  const decoder = mediabunnyDecoder(file);
  try {
    return await sampleFrames(decoder, sampling, options);
  } finally {
    decoder.dispose();
  }
}

/** A clip's length from its container, in whole milliseconds, read before any frame is decoded. */
export async function videoDurationMs(file: Blob): Promise<number> {
  const decoder = mediabunnyDecoder(file);
  try {
    return clipDurationMs(await decoder.duration());
  } finally {
    decoder.dispose();
  }
}

/**
 * The clip's soundtrack as mono windows of about `windowMs`, decoded with the
 * browser's own audio decoder ({@link soundtrackWindows} through
 * {@link mediabunnyDecoder}).
 *
 * @throws With the signal's reason once it aborts.
 */
export async function* extractAudioWindows(
  file: Blob,
  windowMs: number,
  options: { signal?: AbortSignal; maxSampleRate?: number } = {},
): AsyncGenerator<SoundtrackWindow> {
  const decoder = mediabunnyDecoder(file);
  try {
    yield* soundtrackWindows(decoder, windowMs, options);
  } finally {
    decoder.dispose();
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
