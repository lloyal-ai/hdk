import { describe, expect, it } from 'vitest';
import { ensure, run, sleep, spawn, suspend, until } from 'effection';
import type { Operation } from 'effection';
import { asAttachment, DEFAULT_AUDIO_ADMISSION, MANIFEST_TYPE } from '@lloyal-labs/media';
import { Services } from '../src/services';
import { serveCommands } from '../src/serve-commands';
import { useVoiceCommands } from '../src/voice';
import { bufferedCommandSignal } from '../src/buffered-command-signal';
import type { VoiceCommand, VoiceEvent } from '@lloyal-labs/binding';
import type { Transcription } from '../src/transcription';

const audio = asAttachment({ mediaType: MANIFEST_TYPE, digest: `sha256:${'a'.repeat(64)}`, size: 10 })!;
const result: Transcription = { text: 'Hello', audio, representation: { digest: `sha256:${'b'.repeat(64)}`, size: 4, mediaType: 'audio/wav' }, durationSeconds: 1, silent: false, language: 'English', provenance: { model: 'test', projector: 'test', sampleRate: 16000, context: 4096, maxTokens: 512 } };

describe('voice requests', () => {
  it('reports a poisoned voice owner locally, without throwing into the application dispatcher', async () => {
    const events: VoiceEvent[] = [];
    await run(function* () {
      yield* Services.set({ transcription: { limits: DEFAULT_AUDIO_ADMISSION, *transcribe() {
        yield* ensure(() => { throw new Error('native cleanup failed'); });
        yield* suspend();
        return result;
      } } });
      const group = yield* useVoiceCommands({ wire: { *send(event) { events.push(event); } } });
      yield* group.handlers['voice:transcribe']!({ type: 'voice:transcribe', requestId: 'a', audio });
      yield* sleep(0);
      yield* group.handlers['voice:cancel']!({ type: 'voice:cancel', requestId: 'a' });
      yield* sleep(0);
      yield* group.handlers['voice:transcribe']!({ type: 'voice:transcribe', requestId: 'b', audio });
      expect(events).toContainEqual({ type: 'voice:error', requestId: 'b', message: 'Transcription is unavailable after a cleanup failure.' });
    });
  });
  it('keeps work alive after a command handler returns and correlates the result', async () => {
    const events: VoiceEvent[] = [];
    await run(function* () {
      yield* Services.set({ transcription: { limits: DEFAULT_AUDIO_ADMISSION, *transcribe() { yield* sleep(1); return result; } } });
      const group = yield* useVoiceCommands({ wire: { *send(event) { events.push(event); } } });
      const commands = bufferedCommandSignal<VoiceCommand | { type: 'quit' }>();
      const task = yield* spawn(() => serveCommands<VoiceCommand | { type: 'quit' }>(commands, [group]));
      commands.send({ type: 'voice:describe' });
      commands.send({ type: 'voice:transcribe', requestId: 'a', audio });
      yield* sleep(5);
      expect(events).toContainEqual({ type: 'voice:result', requestId: 'a', result });
      commands.send({ type: 'quit' }); yield* task;
    });
  });

  it('cancels immediately on the wire, settles owned work, and suppresses its late result', async () => {
    const events: VoiceEvent[] = []; const log: string[] = [];
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    await run(function* () {
      yield* Services.set({ transcription: { limits: DEFAULT_AUDIO_ADMISSION, *transcribe() {
        log.push('start'); yield* ensure(function* () { yield* until(gate); log.push('settled'); });
        yield* suspend(); return result;
      } } });
      const group = yield* useVoiceCommands({ wire: { *send(event) { events.push(event); } } });
      yield* group.handlers['voice:transcribe']!({ type: 'voice:transcribe', requestId: 'a', audio });
      yield* sleep(0);
      yield* group.handlers['voice:cancel']!({ type: 'voice:cancel', requestId: 'a' });
      expect(events.at(-1)).toEqual({ type: 'voice:cancelled', requestId: 'a' });
      expect(log).toEqual(['start']); release(); yield* sleep(0);
    });
    expect(log).toEqual(['start', 'settled']);
    expect(events.some(event => event.type === 'voice:result')).toBe(false);
  });

  it('refuses malformed roots and unconfigured transcription without starting work', async () => {
    const events: VoiceEvent[] = [];
    await run(function* () {
      const group = yield* useVoiceCommands({ wire: { *send(event) { events.push(event); } } });
      yield* group.handlers['voice:describe']!({ type: 'voice:describe' });
      yield* group.handlers['voice:transcribe']!({ type: 'voice:transcribe', requestId: 'a', audio: { ...audio, mediaType: 'audio/wav' } });
      yield* group.handlers['voice:transcribe']!({ type: 'voice:transcribe', requestId: 'b', audio });
    });
    expect(events[0]).toEqual({ type: 'voice:capabilities', capabilities: { enabled: false } });
    expect(events.filter(event => event.type === 'voice:error')).toHaveLength(2);
  });
});
