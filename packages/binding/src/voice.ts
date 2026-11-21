import type { Attachment, AudioAdmission, Descriptor } from '@lloyal-labs/media';

/** How a transcriber can lean on words the app knows matter: a prompt hint, a decode-time bias, or not at all. */
export type BiasMechanism = 'prompt' | 'decode' | 'none';

/** Words and phrases that matter for one recording. The app says what; the transcriber decides how. */
export interface TranscriptBias {
  readonly terms: readonly string[];
  /** 'hint' suggests; 'prefer' leans hard. Absent means 'hint'. */
  readonly strength?: 'hint' | 'prefer';
}

/** How a bias was honoured, and how many terms it carried. */
export interface AppliedBias {
  readonly applied: BiasMechanism;
  readonly terms: number;
}

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
  /** How the transcriber honoured the bias this call passed. Absent when none was passed or the recording was silent. */
  bias?: AppliedBias;
}

export type VoiceCommand =
  | { type: 'voice:describe' }
  | { type: 'voice:transcribe'; requestId: string; audio: Descriptor }
  | { type: 'voice:cancel'; requestId: string };

export type VoiceCapabilities =
  | { enabled: false }
  | { enabled: true; limits: Readonly<AudioAdmission>; model: string; bias: BiasMechanism };

/** A harness may add text cleanup while preserving the original service result. */
export type VoiceResult = Transcription & { rawText?: string };

export type VoiceEvent =
  | { type: 'voice:capabilities'; capabilities: VoiceCapabilities }
  | { type: 'voice:progress'; requestId: string; phase: 'transcribing' }
  | { type: 'voice:result'; requestId: string; result: VoiceResult }
  | { type: 'voice:error'; requestId: string; message: string }
  | { type: 'voice:cancelled'; requestId: string };
