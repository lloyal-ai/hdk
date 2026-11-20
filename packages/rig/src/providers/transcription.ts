import { Branch, buildUserDeltaMultimodal, deltaCells } from '@lloyal-labs/sdk';
import { Attachments, waitUntilSettled } from '@lloyal-labs/lloyal-agents';
import { audioAdmission, audioLimitsAt, resolveAudio } from '@lloyal-labs/media';
import { ensure, resource } from 'effection';
import type { Operation } from 'effection';
import type { BiasMechanism, TranscriptBias } from '@lloyal-labs/binding';
import { parseTranscription } from '../transcription';
import type { Transcriber } from '../transcription';
import type { ModelBlock } from './index';
import { useServiceContext } from './service-context';

export type TranscriberLoadOpts = Partial<ModelBlock<'transcription'>> & {
  /** How this decoder honours a bias; the Qwen3-ASR prompt context is the default. A decoder that biases at
   *  decode time needs its own provider row, not this one. */
  bias?: BiasMechanism;
};

/** The system-turn sentence a prompt-biased decoder reads. Kept short: it is read on every call. */
export function biasText(terms: readonly string[], strength: TranscriptBias['strength'] = 'hint'): string {
  const kept = terms.map(term => term.trim()).filter(term => term.length > 0);
  if (kept.length === 0) return '';
  const lead = strength === 'prefer'
    ? 'These words matter; spell them exactly as written:'
    : 'These words may be spoken; prefer these spellings:';
  return `${lead} ${kept.join(', ')}.`;
}

/** One owned decoder/projector context, with an isolated branch per admitted recording. */
export function createTranscriber(modelPath: string, projectorPath: string, opts: TranscriberLoadOpts = {}): Operation<Transcriber> {
  return resource(function* (provide) {
    const requested = opts.bias ?? 'prompt';
    if (requested === 'decode') throw new Error('this decoder biases through its prompt; decode-time bias needs a transcriber provider that declares it');
    const bias: 'prompt' | 'none' = requested;
    const context = opts.context ?? 4096;
    const maxTokens = opts.maxTokens ?? 512;
    if (!Number.isSafeInteger(context) || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || context <= maxTokens) {
      throw new Error('transcription context must exceed its positive output token limit');
    }
    const { maxBytes, maxDurationSeconds, maxChannels, maxSampleRate } = opts;
    const limits = Object.freeze(audioAdmission({ maxBytes, maxDurationSeconds, maxChannels, maxSampleRate }));
    const service = yield* useServiceContext({ modelPath, mmprojPath: projectorPath, nCtx: context, nBatch: 128, nSeqMax: 1 });
    const sampleRate = yield* service.run(function* (ctx) { return ctx.supportsAudio() ? ctx.audioSampleRate() : 0; });
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new Error('transcription requires an audio projector');
    const provenance = Object.freeze({
      model: opts.path ? 'local' : opts.id ?? 'local',
      projector: opts.projector?.path ? 'local' : opts.projector?.id ?? 'paired',
      sampleRate, context, maxTokens,
    });
    yield* provide({
      limits,
      bias,
      transcribe: (attachment, hint) => service.run(function* (ctx) {
        const store = yield* Attachments.expect();
        const audio = resolveAudio(store, attachment, limits);
        const result = {
          audio: audio.attachment, representation: audio.representation,
          durationSeconds: audio.metadata.durationSeconds, silent: audio.metadata.silent, provenance,
        };
        if (audio.metadata.silent) return { ...result, text: '' };
        const audioLimits = audioLimitsAt(limits, sampleRate);
        const system = bias === 'prompt' && hint ? biasText(hint.terms, hint.strength) : '';
        const applied = hint && hint.terms.some(term => term.trim())
          ? { applied: bias, terms: hint.terms.filter(term => term.trim()).length }
          : undefined;
        const delta = { ...buildUserDeltaMultimodal(ctx, '', [{ kind: 'audio', bytes: audio.bytes }], { audioLimits, enableThinking: false, ...(system ? { system } : {}) }), sep: [] };
        const demand = yield* waitUntilSettled(deltaCells(ctx, delta));
        if (demand + maxTokens > context) throw new Error('recording and output token limit exceed the transcription context');
        const branch = Branch.create(ctx, 0, { temperature: 0 });
        yield* ensure(() => branch.pruneSync());
        yield* waitUntilSettled(branch.prefillMultimodal(delta.prompt, delta.bitmaps, delta.sep, delta.audioLimits));
        let output = '';
        for (let count = 0; ; count++) {
          const next = branch.produceSync();
          if (next.isStop) return { ...result, ...parseTranscription(output), ...(applied ? { bias: applied } : {}) };
          if (count === maxTokens) throw new Error('transcription reached its output token limit without completing');
          output += next.text;
          yield* waitUntilSettled(branch.commit(next.token));
        }
      }),
    });
  });
}
