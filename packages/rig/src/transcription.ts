import type { Operation } from 'effection';
import type { Attachment, AudioAdmission } from '@lloyal-labs/media';
import type { Transcription } from '@lloyal-labs/binding';
export type { Transcription } from '@lloyal-labs/binding';

export interface Transcriber {
  readonly limits: Readonly<AudioAdmission>;
  transcribe(audio: Attachment): Operation<Transcription>;
}

/** Parse only complete output; callers must separately establish that generation reached a stop token. */
export function parseTranscription(output: string): { text: string; language: string } {
  const match = /^language ([^<>\r\n]+)<asr_text>([\s\S]*)$/.exec(output.trim());
  if (!match || !match[1].trim() || /<\|[^>]*\|>|<asr_text>/.test(match[2])) {
    throw new Error('invalid Qwen ASR output');
  }
  return { language: match[1].trim(), text: match[2].trim() };
}
