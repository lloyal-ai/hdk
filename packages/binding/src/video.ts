import type { Attachment, AudioAdmission, Descriptor, VideoSampling } from '@lloyal-labs/media';

/** One sampled frame: an admitted image root and the time it was sampled at. */
export interface VideoFrameRef {
  root: Descriptor;
  tMs: number;
}

/** One soundtrack window: an admitted audio root and the span of the clip it covers. */
export interface VideoAudioRef {
  root: Descriptor;
  startMs: number;
  endMs: number;
}

/** A soundtrack window the host could not transcribe; the video is composed without it. */
export interface UntranscribedWindow {
  startMs: number;
  endMs: number;
  reason: string;
}

/** What the page needs to sample a clip the way this host will compose it. */
export interface VideoCapabilities {
  sampling: VideoSampling & { maxEdgePx: number };
  /** The longest clip this host composes, in milliseconds, when it sets a limit: the page refuses a longer one
   *  before it pushes any byte. Absent, a clip of any length is taken. */
  maxDurationMs?: number;
  /**
   * The limits each soundtrack window must meet to be transcribed here, or
   * null when no transcription service is bound: the page extracts audio only
   * when there are limits, and cuts its windows to meet them.
   */
  transcription: Readonly<AudioAdmission> | null;
}

/**
 * The page decodes a clip and ingests its frames (and soundtrack windows) one
 * by one through the content plane; this command asks the host to compose them
 * into one video attachment. References only: bytes travel over HTTP. The host
 * composes under its own sampling, the one it described.
 */
export type VideoCommand =
  | { type: 'video:describe' }
  | {
      type: 'video:compose';
      requestId: string;
      frames: VideoFrameRef[];
      audio?: VideoAudioRef[];
      durationMs: number;
      /** The original, pushed as a blob, retained as the source layer. */
      source?: Descriptor;
    }
  | { type: 'video:cancel'; requestId: string };

export type VideoEvent =
  | { type: 'video:capabilities'; capabilities: VideoCapabilities }
  | { type: 'video:progress'; requestId: string; phase: 'transcribing'; done: number; total: number }
  | { type: 'video:composed'; requestId: string; root: Attachment; untranscribed: UntranscribedWindow[] }
  | { type: 'video:error'; requestId: string; message: string }
  | { type: 'video:cancelled'; requestId: string };
