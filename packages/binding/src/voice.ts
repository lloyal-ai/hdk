import type { Attachment, AudioAdmission, Descriptor } from '@lloyal-labs/media';

/** A completed transcription, including the admitted audio and its inference provenance. */
export interface Transcription {
  text: string;
  /** Model-reported language, absent for silence; it is not a confidence estimate. */
  language?: string;
  audio: Attachment;
  representation: Descriptor;
  durationSeconds: number;
  silent: boolean;
  provenance: { model: string; projector: string; sampleRate: number; context: number; maxTokens: number };
}

export type VoiceCommand =
  | { type: 'voice:describe' }
  | { type: 'voice:transcribe'; requestId: string; audio: Descriptor }
  | { type: 'voice:cancel'; requestId: string };

export type VoiceCapabilities =
  | { enabled: false }
  | { enabled: true; limits: Readonly<AudioAdmission>; model: string };

/** A harness may add text cleanup while preserving the original service result. */
export type VoiceResult = Transcription & { rawText?: string };

export type VoiceEvent =
  | { type: 'voice:capabilities'; capabilities: VoiceCapabilities }
  | { type: 'voice:progress'; requestId: string; phase: 'transcribing' }
  | { type: 'voice:result'; requestId: string; result: VoiceResult }
  | { type: 'voice:error'; requestId: string; message: string }
  | { type: 'voice:cancelled'; requestId: string };
