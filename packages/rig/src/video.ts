/**
 * `video:compose` — the host's half of attaching a video.
 *
 * The page decodes a clip into frames and soundtrack windows and ingests each
 * through the content plane, pushes the original as a blob, then sends this
 * command with references only. The host checks every reference, transcribes
 * the windows through the bound transcription service (block presence is the
 * only switch: no service, no transcript), and composes one video attachment.
 * It keeps a clip's sound whenever anything it runs hears: the transcription
 * service, or an embedding model that reads sound.
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
import { asAttachment, commonAdmission, composeVideo, DIGEST_PATTERN, durationRefusal, resolveAudio, soundtrackRefusal } from '@lloyal-labs/media';
import type { Attachment, AttachmentStore, AudioAdmission, Descriptor, Transcript } from '@lloyal-labs/media';
import { isRequestId } from '@lloyal-labs/binding';
import type { UntranscribedWindow, VideoCapabilities, VideoCommand, VideoEvent } from '@lloyal-labs/binding';
import { DEFAULT_VIDEO_SAMPLING } from './config';
import type { attachmentSettings, ConfigOf } from './config';
import { Services } from './services';
import type { ServiceMap } from './services';
import type { CommandGroup } from './serve-commands';

/** The harness's video block, as its config hands it over: absent keys, or no block, take rig's defaults. */
export type VideoSettings = { attachments?: { video?: Partial<NonNullable<ConfigOf<typeof attachmentSettings>['attachments']['video']>> } };

export interface VideoCommandsOptions {
  wire: { send(event: VideoEvent): Operation<void> };
  /** The harness's config, read each time a video is described or composed, so a change applies to the next one. */
  config?: () => VideoSettings;
}

/** The policy a video is sampled and composed under now: the harness's video block over rig's defaults, and
 *  a length limit only when the harness sets one. */
function videoPolicy(settings: VideoSettings): Pick<VideoCapabilities, 'sampling' | 'maxDurationMs'> {
  const { fps, maxFrames, maxEdgePx, soundtrackWindowSeconds, maxDurationSeconds } = settings.attachments?.video ?? {};
  const soundtrackWindowMs = soundtrackWindowSeconds !== undefined ? Math.round(soundtrackWindowSeconds * 1000) : undefined;
  const sampled = Object.fromEntries(Object.entries({ fps, maxFrames, maxEdgePx, soundtrackWindowMs }).filter(([, v]) => v !== undefined));
  return {
    sampling: { ...DEFAULT_VIDEO_SAMPLING, ...sampled },
    ...(maxDurationSeconds !== undefined ? { maxDurationMs: maxDurationSeconds * 1000 } : {}),
  };
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
  if (audio.some(a => !a.root || !isMs(a.startMs) || !isMs(a.endMs))) {
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
 * The sentence refusing a soundtrack, if a window is not a recording this
 * store admitted (read back under the admission the host keeps sound under,
 * what every service that hears takes) or has no place on the clip's timeline (media's rule, the one the
 * composition keeps). Checked before any window is transcribed, with or
 * without a transcription service, as a frame is.
 */
function unadmittedOrMisplaced(
  store: AttachmentStore,
  windows: readonly { root: Attachment; startMs: number; endMs: number }[],
  durationMs: unknown,
  limits?: Readonly<AudioAdmission>,
): string | undefined {
  const unadmitted = (w: { root: Attachment }, i: number): string | undefined => {
    try {
      resolveAudio(store, w.root, limits);
      return undefined;
    } catch (e) {
      return `Soundtrack window ${i} is not an admitted recording: ${message(e)}`;
    }
  };
  return windows.map(unadmitted).find((r) => r !== undefined) ?? soundtrackRefusal(windows, durationMs);
}

/** What this host keeps of a clip's sound, as the admission each window meets: what every bound service that hears
 *  admits, so each window reaches all of them; none when nothing hears, and the page extracts none. */
function soundtrackAdmission(services: Partial<ServiceMap> | undefined): Readonly<AudioAdmission> | null {
  const hearers = [services?.transcription?.limits, services?.embedding?.audio];
  return commonAdmission(hearers.filter((a): a is Readonly<AudioAdmission> => a != null));
}

/** The commands that compose a video, for a harness to serve beside its own. */
export function useVideoCommands({ wire, config = () => ({}) }: VideoCommandsOptions): Operation<CommandGroup<VideoCommand>> {
  return resource(function* (provide) {
    const owner = yield* useScope();
    const store = yield* Attachments.expect();
    const services = yield* Services.get();
    const asr = services?.transcription;
    const soundtrack = soundtrackAdmission(services);
    const composing = new Map<string, Task<void>>();

    /** Transcribe each window in turn: silence is skipped, a failure is recorded and the rest go on. */
    function* transcribe(requestId: string, windows: { root: Attachment; startMs: number; endMs: number }[]) {
      const segments: Transcript['segments'] = [];
      const untranscribed: UntranscribedWindow[] = [];
      let provenance: Transcript['provenance'] = {};
      // A video without a soundtrack has nothing to transcribe, and says nothing about it.
      if (windows.length === 0) return { transcript: undefined, untranscribed };
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
          yield* wire.send({ type: 'video:capabilities', capabilities: { ...videoPolicy(config()), soundtrack } });
        },
        *'video:compose'(command) {
          if (!isRequestId(command.requestId)) return;
          const { requestId } = command;
          // One task per id: a second under the same id would take its place and leave the first uncancellable.
          if (composing.has(requestId)) {
            yield* wire.send({ type: 'video:error', requestId, message: 'A video is already being composed under that request.' });
            return;
          }
          const { sampling, maxDurationMs } = videoPolicy(config());
          // What the timeline is composed from: the policy the page was told to sample by, never one it
          // reports back. Composition widens its mark interval as the frames require (media's markInterval).
          const timeline = { fps: sampling.fps, timestampIntervalMs: sampling.timestampIntervalMs, maxFrames: sampling.maxFrames };
          const tooLong = isMs(command.durationMs) ? durationRefusal(command.durationMs, maxDurationMs) : undefined;
          if (tooLong) {
            yield* wire.send({ type: 'video:error', requestId, message: tooLong });
            return;
          }
          const refs = references(command, sampling.maxFrames);
          if ('refused' in refs) {
            yield* wire.send({ type: 'video:error', requestId, message: refs.refused });
            return;
          }
          const unfit = unadmittedOrMisplaced(store, refs.audio, command.durationMs, soundtrack ?? undefined);
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
                frames: refs.frames, sampling: timeline, durationMs: command.durationMs, soundtrack: refs.audio,
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
