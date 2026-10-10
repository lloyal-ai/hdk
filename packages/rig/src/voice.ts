import { resource, spawn, useScope } from 'effection';
import type { Operation } from 'effection';
import { asAttachment } from '@lloyal-labs/media';
import type { Attachment } from '@lloyal-labs/media';
import { Services } from './services';
import { useExecution } from './execution';
import type { CommandGroup } from './serve-commands';
import type { VoiceCommand, VoiceEvent, VoiceResult } from '@lloyal-labs/binding';

export interface VoiceCommandsOptions {
  wire: { send(event: VoiceEvent): Operation<void> };
  model?: string;
  /** Harness-owned composition, for example optional text normalization after transcription. */
  transcribe?: (audio: Attachment) => Operation<VoiceResult>;
}

/** An independent execution owner keeps dictation alive across short command-handler scopes. */
export function useVoiceCommands({ wire, model = 'Transcription', transcribe }: VoiceCommandsOptions): Operation<CommandGroup<VoiceCommand>> {
  return resource(function* (provide) {
    const execution = yield* useExecution();
    const owner = yield* useScope();
    const asr = (yield* Services.get())?.transcription;
    let current: { id: string } | null = null;
    yield* spawn(function* () {
      const error = yield* execution.whenPoisoned;
      if (current) yield* wire.send({ type: 'voice:error', requestId: current.id, message: error.message });
      current = null;
    });
    yield* provide({
      handlers: {
        *'voice:describe'() {
          yield* wire.send({ type: 'voice:capabilities', capabilities: asr && !execution.poisoned ? { enabled: true, limits: asr.limits, model } : { enabled: false } });
        },
        *'voice:transcribe'(command) {
          if (typeof command.requestId !== 'string' || !command.requestId || command.requestId.length > 128) return;
          const requestId = command.requestId;
          if (execution.poisoned) {
            yield* wire.send({ type: 'voice:error', requestId, message: 'Transcription is unavailable after a cleanup failure.' });
            return;
          }
          const audio = asAttachment(command.audio);
          if (!audio || !asr) {
            yield* wire.send({ type: 'voice:error', requestId, message: audio ? 'Transcription is not configured.' : 'The recording is not an admitted audio reference.' });
            return;
          }
          if (current) yield* wire.send({ type: 'voice:cancelled', requestId: current.id });
          const request = { id: requestId };
          current = request;
          const owns = (): boolean => current === request;
          const accepted = yield* execution.replace(requestId, function* () {
            yield* wire.send({ type: 'voice:progress', requestId, phase: 'transcribing' });
            const result = yield* (transcribe ? transcribe({ ...audio }) : asr.transcribe({ ...audio }));
            if (owns()) yield* wire.send({ type: 'voice:result', requestId, result });
          });
          yield* owner.spawn(function* () {
            try {
              yield* accepted;
            } catch (error) {
              if (owns()) yield* wire.send({ type: 'voice:error', requestId, message: error instanceof Error ? error.message : 'Transcription failed.' });
            } finally {
              if (owns()) current = null;
            }
          });
        },
        *'voice:cancel'({ requestId }) {
          if (requestId !== current?.id) return;
          current = null;
          yield* execution.stop();
          yield* wire.send({ type: 'voice:cancelled', requestId });
        },
      },
    });
  });
}
