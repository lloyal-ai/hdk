/**
 * `video:compose` — the host's half of attaching a video.
 *
 * The page decodes a clip into frames and soundtrack windows and ingests each
 * through the content plane, pushes the original as a blob, then sends this
 * command with references only. The host checks every reference, transcribes
 * the windows through the bound transcription service (block presence is the
 * only switch: no service, no transcript), and composes one video attachment.
 *
 * Each compose runs in its own task, so several videos attached in a row
 * compose side by side and a Stop of the run does not reach them; the
 * transcription service serializes its own calls.
 *
 * @category Rig
 */
import { resource, until, useAbortSignal, useScope } from 'effection';
import type { Operation, Task } from 'effection';
import { Attachments } from '@lloyal-labs/lloyal-agents';
import { asAttachment, composeVideo, DIGEST_PATTERN, resolveAudio } from '@lloyal-labs/media';
import type { Attachment, AttachmentStore, AudioAdmission, Descriptor, Transcript } from '@lloyal-labs/media';
import type { UntranscribedWindow, VideoCapabilities, VideoCommand, VideoEvent } from '@lloyal-labs/binding';
import { Services } from './services';
import type { CommandGroup } from './serve-commands';

/**
 * How a clip is sampled when nothing says otherwise: llama.cpp's own video
 * defaults (4 fps, a timestamp every 5 s), a frame cap that keeps a clip within
 * a working context, and a longest edge that keeps each frame's projection
 * small. A clip longer than `maxFrames / fps` is sampled more sparsely.
 *
 * @category Rig
 */
export const DEFAULT_VIDEO_SAMPLING: VideoCapabilities['sampling'] = Object.freeze({
  fps: 4,
  timestampIntervalMs: 5000,
  maxFrames: 64,
  maxEdgePx: 640,
});

export interface VideoCommandsOptions {
  wire: { send(event: VideoEvent): Operation<void> };
  sampling?: VideoCapabilities['sampling'];
}

type Compose = Extract<VideoCommand, { type: 'video:compose' }>;

const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A client's descriptor of a pushed blob, or null. Its type is decided later, from its bytes. */
function asBlob(d: unknown): Descriptor | null {
  if (typeof d !== 'object' || d === null) return null;
  const { digest, mediaType, size } = d as Record<string, unknown>;
  return typeof digest === 'string' && DIGEST_PATTERN.test(digest) && typeof mediaType === 'string' &&
    typeof size === 'number' && Number.isSafeInteger(size) && size >= 0
    ? { digest, mediaType, size }
    : null;
}

/** The command's references as admitted roots, or the sentence that refuses them. */
function references(command: Compose, maxFrames: number):
  | { frames: { root: Attachment; tMs: number }[]; audio: { root: Attachment; startMs: number; endMs: number }[]; source?: Descriptor }
  | { refused: string } {
  const frames = (Array.isArray(command.frames) ? command.frames : []).map(f => ({ root: asAttachment(f?.root), tMs: f?.tMs }));
  if (frames.some(f => !f.root || !isMs(f.tMs))) return { refused: 'A frame is not an admitted image reference.' };
  if (frames.length > maxFrames) return { refused: `This host composes at most ${maxFrames} frames a video, not ${frames.length}.` };
  const audio = (Array.isArray(command.audio) ? command.audio : []).map(a => ({ root: asAttachment(a?.root), startMs: a?.startMs, endMs: a?.endMs }));
  if (audio.some(a => !a.root || !isMs(a.startMs) || !isMs(a.endMs) || a.endMs < a.startMs)) {
    return { refused: 'A soundtrack window is not an admitted audio reference.' };
  }
  const source = command.source === undefined ? undefined : asBlob(command.source);
  if (source === null) return { refused: 'The original is not a stored blob reference.' };
  return {
    frames: frames as { root: Attachment; tMs: number }[],
    audio: audio as { root: Attachment; startMs: number; endMs: number }[],
    ...(source ? { source } : {}),
  };
}

/**
 * The sentence refusing a soundtrack window, if one is not a recording this
 * store admitted (read back under the admission limits it will be transcribed
 * under) or runs past the clip. Checked before any window is transcribed, with
 * or without a transcription service, as a frame is.
 */
function soundtrackRefusal(
  store: AttachmentStore,
  windows: readonly { root: Attachment; endMs: number }[],
  durationMs: unknown,
  limits?: Readonly<AudioAdmission>,
): string | undefined {
  const refusal = (w: { root: Attachment; endMs: number }, i: number): string | undefined => {
    try {
      resolveAudio(store, w.root, limits);
    } catch (e) {
      return `Soundtrack window ${i} is not an admitted recording: ${message(e)}`;
    }
    return isMs(durationMs) && w.endMs <= durationMs ? undefined : `Soundtrack window ${i} runs past the end of the clip.`;
  };
  return windows.map(refusal).find((r) => r !== undefined);
}

/** The commands that compose a video, for a harness to serve beside its own. */
export function useVideoCommands({ wire, sampling = DEFAULT_VIDEO_SAMPLING }: VideoCommandsOptions): Operation<CommandGroup<VideoCommand>> {
  return resource(function* (provide) {
    const owner = yield* useScope();
    const store = yield* Attachments.expect();
    const asr = (yield* Services.get())?.transcription;
    const composing = new Map<string, Task<void>>();
    // What the timeline records: the policy the page was told to sample by, never one it reports back.
    const timeline = { fps: sampling.fps, timestampIntervalMs: sampling.timestampIntervalMs, maxFrames: sampling.maxFrames };

    /** Transcribe each window in turn: silence is skipped, a failure is recorded and the rest go on. */
    function* transcribe(requestId: string, windows: { root: Attachment; startMs: number; endMs: number }[]) {
      const segments: Transcript['segments'] = [];
      const untranscribed: UntranscribedWindow[] = [];
      let provenance: Transcript['provenance'] = {};
      yield* wire.send({ type: 'video:progress', requestId, phase: 'transcribing', done: 0, total: windows.length });
      for (const [i, w] of windows.entries()) {
        if (!asr) {
          untranscribed.push({ startMs: w.startMs, endMs: w.endMs, reason: 'transcription is not configured' });
          continue;
        }
        try {
          const heard = yield* asr.transcribe({ ...w.root });
          provenance = Object.fromEntries(Object.entries(heard.provenance).map(([k, v]) => [k, String(v)]));
          if (!heard.silent && heard.text.trim()) {
            segments.push({ startMs: w.startMs, endMs: w.endMs, text: heard.text.trim(), ...(heard.language ? { language: heard.language } : {}) });
          }
        } catch (e) {
          untranscribed.push({ startMs: w.startMs, endMs: w.endMs, reason: message(e) });
        }
        yield* wire.send({ type: 'video:progress', requestId, phase: 'transcribing', done: i + 1, total: windows.length });
      }
      return { transcript: segments.length > 0 ? { provenance, segments } : undefined, untranscribed };
    }

    yield* provide({
      handlers: {
        *'video:describe'() {
          yield* wire.send({ type: 'video:capabilities', capabilities: { sampling, transcription: Boolean(asr) } });
        },
        *'video:compose'(command) {
          if (typeof command.requestId !== 'string' || !command.requestId || command.requestId.length > 128) return;
          const { requestId } = command;
          // One task per id: a second under the same id would take its place and leave the first uncancellable.
          if (composing.has(requestId)) {
            yield* wire.send({ type: 'video:error', requestId, message: 'A video is already being composed under that request.' });
            return;
          }
          const refs = references(command, sampling.maxFrames);
          if ('refused' in refs) {
            yield* wire.send({ type: 'video:error', requestId, message: refs.refused });
            return;
          }
          const unfit = soundtrackRefusal(store, refs.audio, command.durationMs, asr?.limits);
          if (unfit !== undefined) {
            yield* wire.send({ type: 'video:error', requestId, message: unfit });
            return;
          }
          const task = yield* owner.spawn(function* () {
            try {
              const { transcript, untranscribed } = yield* transcribe(requestId, refs.audio);
              // The composition is a promise; the scope's signal reaches it as a leaf, so a cancel
              // that lands while it reads the source stops it before it writes anything.
              const signal = yield* useAbortSignal();
              const root = yield* until(composeVideo(store, {
                frames: refs.frames, sampling: timeline, durationMs: command.durationMs,
                ...(transcript ? { transcript } : {}),
                ...(refs.source ? { source: refs.source } : {}),
              }, signal));
              yield* wire.send({ type: 'video:composed', requestId, root, untranscribed });
            } catch (e) {
              yield* wire.send({ type: 'video:error', requestId, message: message(e) });
            } finally {
              composing.delete(requestId);
            }
          });
          composing.set(requestId, task);
        },
        *'video:cancel'({ requestId }) {
          const task = composing.get(requestId);
          if (!task) return;
          composing.delete(requestId);
          yield* task.halt();
          yield* wire.send({ type: 'video:cancelled', requestId });
        },
      },
    });
  });
}
