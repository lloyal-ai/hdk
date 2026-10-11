import { describe, expect, it } from 'vitest';
import * as transcription from '../src/transcription';

describe('Qwen ASR output', () => {
  it('separates model-reported language from raw transcription', () => {
    expect(transcription.parseTranscription('language English<asr_text>Meet at 9:30.')).toEqual({ language: 'English', text: 'Meet at 9:30.' });
    expect(transcription.parseTranscription('language Chinese<asr_text>你好。')).toEqual({ language: 'Chinese', text: '你好。' });
  });
  it.each(['', 'invented prefix', 'language English', 'language <asr_text>words', 'language English<asr_text>hello<|im_end|>'])('refuses malformed or leaked control output %j', output => {
    expect(() => transcription.parseTranscription(output)).toThrow(/ASR output/);
  });
});
