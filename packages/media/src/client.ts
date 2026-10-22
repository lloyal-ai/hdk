/**
 * @file `@lloyal-labs/media/client` — the half that needs a page.
 *
 * The page decodes a clip with WebCodecs, Mediabunny reading the container:
 * `mediabunnyDecoder` is that decoder, and `sampleVideo` and
 * `extractAudioWindows` read a file through it. What they produce is ordinary
 * content (JPEG frames, PCM WAV windows) for the content plane's ingress to
 * admit like any other image or recording. The procedure they run, and the
 * decoder contract another runtime implements, are in the root entry.
 *
 * `mediabunny` is an OPTIONAL peer, needed only by this entry.
 */
export { captureFrames, extractAudioWindows, mediabunnyDecoder, sampleVideo, videoDurationMs } from './video-sampling';
// The procedure's pure parts, kept on this entry for code that imports them from here; the root entry has them all.
export { fitEdge, frameTimes, pcm16Wav, quietestCut, SoundtrackCutter, soundtrackWindowMs } from './clip';
export type { SampledFrame, SoundtrackWindow } from './clip';
