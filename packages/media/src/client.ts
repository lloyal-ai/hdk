/**
 * @file `@lloyal-labs/media/client` — the half that needs a page.
 *
 * Video can only be decoded where a codec is: the browser's WebCodecs, with
 * Mediabunny reading the container. What this entry produces is ordinary
 * content — JPEG frames, PCM WAV windows — for the content plane's ingress to
 * admit like any other image or recording.
 *
 * `mediabunny` is an OPTIONAL peer, needed only by this entry.
 */
export {
  captureFrames, extractAudioWindows, fitEdge, frameTimes, pcm16Wav, quietestCut, sampleVideo, SoundtrackCutter, soundtrackWindowMs, videoDurationMs,
} from './video-sampling';
export type { SampledFrame, SoundtrackWindow } from './video-sampling';
