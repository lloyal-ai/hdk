import { createContext } from '@lloyal-labs/sdk/node';
import { Branch, buildUserDeltaMultimodal, deltaCells } from '@lloyal-labs/sdk';
import { waitUntilSettled } from '@lloyal-labs/lloyal-agents';
import { audioAdmission, resolveAudio } from '@lloyal-labs/media';
import type { AttachmentStore } from '@lloyal-labs/media';
import { ensure, resource, scoped } from 'effection';
import type { Operation } from 'effection';
import { acquire } from '../acquire';
import { RunnerCtx } from '../runner';
import { parseTranscription } from '../transcription';
import type { Transcriber } from '../transcription';
import type { ModelBlock } from './index';
import { useSerialExecutor } from './serial';

export type TranscriberLoadOpts = Partial<ModelBlock<'transcription'>> & { store?: AttachmentStore };

/** One owned decoder/projector context, with an isolated branch per admitted recording. */
export function createTranscriber(modelPath: string, projectorPath: string, opts: TranscriberLoadOpts = {}): Operation<Transcriber> {
  return resource(function* (provide) {
    const context = opts.context ?? 4096;
    const maxTokens = opts.maxTokens ?? 512;
    if (!Number.isSafeInteger(context) || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || context <= maxTokens) {
      throw new Error('transcription context must exceed its positive output token limit');
    }
    const { maxBytes, maxDurationSeconds, maxChannels, maxSampleRate } = opts;
    const limits = Object.freeze(audioAdmission({ maxBytes, maxDurationSeconds, maxChannels, maxSampleRate }));
    const ctx = yield* acquire(() => createContext({
      modelPath, mmprojPath: projectorPath, nCtx: context, nBatch: 128, nSeqMax: 1,
    }), ctx => ctx.dispose());
    const sampleRate = ctx.audioSampleRate();
    if (!ctx.supportsAudio() || !Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new Error('transcription requires an audio projector');
    const serial = yield* useSerialExecutor();
    const provenance = Object.freeze({
      model: opts.path ? 'local' : opts.id ?? 'local',
      projector: opts.projector?.path ? 'local' : opts.projector?.id ?? 'paired',
      sampleRate, context, maxTokens,
    });
    yield* provide({
      limits,
      transcribe: attachment => serial.run(() => scoped(function* () {
        const store = opts.store ?? (yield* RunnerCtx.expect()).attachmentStore;
        const audio = resolveAudio(store, attachment, limits);
        const result = {
          audio: audio.attachment, representation: audio.representation,
          durationSeconds: audio.metadata.durationSeconds, silent: audio.metadata.silent, provenance,
        };
        if (audio.metadata.silent) return { ...result, text: '' };
        // One resampling headroom sample matches the pinned native admission bound.
        const audioLimits = { maxBytes: limits.maxBytes, maxSamples: Math.ceil(limits.maxDurationSeconds * sampleRate) + 1 };
        const delta = { ...buildUserDeltaMultimodal(ctx, '', [{ kind: 'audio', bytes: audio.bytes }], { audioLimits, enableThinking: false }), sep: [] };
        const demand = yield* waitUntilSettled(deltaCells(ctx, delta));
        if (demand + maxTokens > context) throw new Error('recording and output token limit exceed the transcription context');
        const branch = Branch.create(ctx, 0, { temperature: 0 });
        yield* ensure(() => branch.pruneSync());
        yield* waitUntilSettled(branch.prefillMultimodal(delta.prompt, delta.bitmaps, delta.sep, delta.audioLimits));
        let output = '';
        for (let count = 0; ; count++) {
          const next = branch.produceSync();
          if (next.isStop) return { ...result, ...parseTranscription(output) };
          if (count === maxTokens) throw new Error('transcription reached its output token limit without completing');
          output += next.text;
          yield* waitUntilSettled(branch.commit(next.token));
        }
      })),
    });
  });
}
