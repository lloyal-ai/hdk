/**
 * A video, attached from the page: read here, composed by the host.
 *
 * The page is where a clip can be decoded, so `@lloyal-labs/media/client`
 * samples the frames the model will see and cuts the soundtrack into windows
 * for the transcription service, and the original is pushed as a blob. Each
 * frame and window enters through the content plane's ordinary ingress; one
 * `video:compose` then asks the host to make them one attachment. Bytes travel
 * over HTTP, the socket carries references, and the host authors the manifest.
 *
 * @category UI
 */
import { useEffect, useState } from 'react';
import { ingestMedia, pushBlob } from '@lloyal-labs/media';
import { extractAudioWindows, sampleVideo } from '@lloyal-labs/media/client';
import type { Attachment, Descriptor } from '@lloyal-labs/media';
import type { UntranscribedWindow, VideoCapabilities, VideoCommand, VideoEvent, VideoFrameRef, VideoAudioRef } from '@lloyal-labs/binding';
import { useAvailability, useContentOrigin, useHarness } from './provider.js';

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
    // Every way this ends lets go of both listeners; an abort tells the host and does not wait for it.
    const settle = (end: () => void): void => { stop(); signal?.removeEventListener('abort', onAbort); end(); };
    const onAbort = (): void => { bridge.send({ type: 'video:cancel', requestId }); settle(() => reject(signal?.reason)); };
    const stop = bridge.onEvent(({ ev: event }) => {
      if (!isVideoEvent(event) || !('requestId' in event) || event.requestId !== requestId) return;
      const ev = event;
      if (ev.type === 'video:progress') onProgress?.({ phase: 'transcribing', done: ev.done, total: ev.total });
      if (ev.type === 'video:composed') settle(() => resolve({ root: ev.root, untranscribed: ev.untranscribed }));
      if (ev.type === 'video:error') settle(() => reject(new Error(ev.message)));
      if (ev.type === 'video:cancelled') settle(() => reject(new DOMException('The video was cancelled.', 'AbortError')));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
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
    if (signal?.aborted) { reject(signal.reason); return; }
    const onAbort = (): void => { stop(); reject(signal?.reason); };
    const stop = bridge.onEvent(({ ev }) => {
      if (isVideoEvent(ev) && ev.type === 'video:capabilities') {
        stop();
        signal?.removeEventListener('abort', onAbort);
        resolve(ev.capabilities);
      }
    });
    signal?.addEventListener('abort', onAbort, { once: true });
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
