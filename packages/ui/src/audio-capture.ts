import { audioAdmission } from '@lloyal-labs/media';
import type { AudioAdmission } from '@lloyal-labs/media';

export interface AudioCapture {
  /** Resolves after Stop or the recording limit; rejects on cancellation or device loss. */
  result: Promise<Uint8Array>;
  stop(): void;
}

export function encodePcmWav(chunks: readonly Int16Array[], sampleRate: number, maxBytes: number): Uint8Array {
  const frames = chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (frames < 2) throw new Error('The recording is too short.');
  const size = 44 + frames * 2;
  if (!Number.isSafeInteger(size) || size > maxBytes || size > 0xffffffff) throw new Error('The recording exceeds its byte limit.');
  const bytes = new Uint8Array(size); const view = new DataView(bytes.buffer);
  const tag = (at: number, value: string) => bytes.set(new TextEncoder().encode(value), at);
  tag(0, 'RIFF'); view.setUint32(4, size - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, frames * 2, true);
  let offset = 44;
  for (const chunk of chunks) for (const sample of chunk) { view.setInt16(offset, sample, true); offset += 2; }
  return bytes;
}

/** Capture once, with track, graph, timer and worklet lifetimes owned by the caller's signal. */
export async function startAudioCapture(opts: {
  signal: AbortSignal;
  limits?: Partial<AudioAdmission>;
  onLevel(level: number, elapsed: number): void;
}): Promise<AudioCapture> {
  const limits = audioAdmission(opts.limits);
  opts.signal.throwIfAborted();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access requires a secure page and a supported browser.');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
  if (opts.signal.aborted) { stream.getTracks().forEach(track => track.stop()); opts.signal.throwIfAborted(); }
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let muted: GainNode | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let resolve!: (bytes: Uint8Array) => void;
  let reject!: (reason: unknown) => void;
  const result = new Promise<Uint8Array>((yes, no) => { resolve = yes; reject = no; });
  // Setup may fail before the caller receives result; the setup rejection still reaches that caller.
  void result.catch(() => {});
  const chunks: Int16Array[] = [];
  let received = 0;
  const cleanup = (): void => {
    clearTimeout(timer);
    opts.signal.removeEventListener('abort', abort);
    stream.getTracks().forEach(track => { track.removeEventListener('ended', lost); track.stop(); });
    source?.disconnect(); node?.disconnect(); muted?.disconnect();
    if (node) { node.port.onmessage = null; node.port.close(); }
    if (context && context.state !== 'closed') void context.close().catch(() => {});
  };
  const fail = (error: unknown): void => { if (finished) return; finished = true; cleanup(); chunks.length = 0; reject(error); };
  const abort = (): void => fail(opts.signal.reason ?? new DOMException('Recording cancelled', 'AbortError'));
  const lost = (): void => fail(new Error('The microphone disconnected.'));
  opts.signal.addEventListener('abort', abort, { once: true });
  stream.getTracks().forEach(track => track.addEventListener('ended', lost, { once: true }));
  try {
    context = new AudioContext({ sampleRate: Math.min(48000, limits.maxSampleRate) });
    if (context.sampleRate > limits.maxSampleRate) throw new Error('The microphone sample rate exceeds the configured limit.');
    await context.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
    opts.signal.throwIfAborted();
    const maxFrames = Math.floor(Math.min(limits.maxDurationSeconds * context.sampleRate, (limits.maxBytes - 44) / 2));
    if (maxFrames < 2) throw new Error('The recording limit is too small.');
    node = new AudioWorkletNode(context, 'lloyal-pcm-capture', { channelCount: 1, channelCountMode: 'explicit', processorOptions: { maxFrames } });
    node.onprocessorerror = () => fail(new Error('The microphone processor stopped unexpectedly.'));
    node.port.onmessage = ({ data }: MessageEvent<{ samples?: Int16Array; level?: number; elapsed?: number; done?: boolean }>) => {
      if (finished) return;
      if (data.samples) {
        received += data.samples.length;
        if (received > maxFrames) { fail(new Error('The recording exceeds its sample limit.')); return; }
        chunks.push(data.samples);
        opts.onLevel(data.level ?? 0, data.elapsed ?? 0);
      }
      if (data.done) {
        try {
          const bytes = encodePcmWav(chunks, context!.sampleRate, limits.maxBytes);
          finished = true; cleanup(); chunks.length = 0; resolve(bytes);
        } catch (error) { fail(error); }
      }
    };
    source = context.createMediaStreamSource(stream); muted = context.createGain(); muted.gain.value = 0;
    source.connect(node); node.connect(muted); muted.connect(context.destination);
    await context.resume();
    opts.signal.throwIfAborted();
    const stop = (): void => {
      if (finished) return;
      stream.getTracks().forEach(track => track.stop());
      node!.port.postMessage({ stop: true });
      clearTimeout(timer);
      timer = setTimeout(() => fail(new Error('The microphone did not finish recording.')), 1000);
    };
    timer = setTimeout(stop, limits.maxDurationSeconds * 1000);
    return { result, stop };
  } catch (error) { fail(error); throw error; }
}
