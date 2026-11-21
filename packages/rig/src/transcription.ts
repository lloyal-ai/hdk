import type { Operation } from 'effection';
import type { Attachment, AudioAdmission } from '@lloyal-labs/media';
import type { BiasMechanism, Transcription, TranscriptBias } from '@lloyal-labs/binding';
export type { AppliedBias, BiasMechanism, Transcription, TranscriptBias } from '@lloyal-labs/binding';

export interface Transcriber {
  readonly limits: Readonly<AudioAdmission>;
  /** How this transcriber can honour a bias; declared once at bind time, so a view can say what the dictionary
   *  will and will not affect. */
  readonly bias: BiasMechanism;
  transcribe(audio: Attachment, bias?: TranscriptBias): Operation<Transcription>;
}

/** Parse only complete output; callers must separately establish that generation reached a stop token. */
export function parseTranscription(output: string): { text: string; language: string } {
  const match = /^language ([^<>\r\n]+)<asr_text>([\s\S]*)$/.exec(output.trim());
  if (!match || !match[1].trim() || /<\|[^>]*\|>|<asr_text>/.test(match[2])) {
    throw new Error('invalid Qwen ASR output');
  }
  return { language: match[1].trim(), text: match[2].trim() };
}
