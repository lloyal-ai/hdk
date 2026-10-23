/**
 * Build scenario packs: long clips ingested the way a reader's video is, into
 * one OCI media store, for lloyal.node's scenario suite to read by root digest.
 *
 * Everything but the decoder is what a page and a host do with a video:
 * `video:describe` gives the host's policy and transcription limits, media's
 * `prepareVideo` samples and ingests the frames and soundtrack windows under
 * it, and `video:compose` transcribes each window through Qwen3-ASR and
 * commits the video. The page decodes with WebCodecs; this decodes with ffmpeg
 * (`./ffmpeg-decoder.ts`), and each pack records that.
 *
 * Usage, from the hdk root after `npm run build`:
 *   LLOYAL_LOCAL=1 npx tsx scripts/scenario-pack.ts <store dir> <name>=<video> [<name>=<video> ...]
 *
 * Writes the packs into `<store dir>` and what each one is into `<store dir>/packs.json`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { call, main, withResolvers } from 'effection';
import type { Operation } from 'effection';
import { Attachments } from '@lloyal-labs/lloyal-agents';
import { prepareVideo, sniffMediaType } from '@lloyal-labs/media';
import type { Attachment } from '@lloyal-labs/media';
import { createContentIngress, FileAttachmentStore } from '@lloyal-labs/media/node';
import { Services, useVideoCommands } from '@lloyal-labs/rig';
import { createTranscriber } from '@lloyal-labs/rig/node';
import { isRequestId } from '@lloyal-labs/binding';
import type { UntranscribedWindow, VideoCapabilities, VideoCommand, VideoEvent } from '@lloyal-labs/binding';
import { ffmpegDecoder } from './ffmpeg-decoder';

/** The harness's video block the packs are composed under: one frame a second, up to an hour. */
const VIDEO = { fps: 1, maxFrames: 3600 };

const models = resolve(__dirname, '../../lloyal-node/models/audio/qwen3-asr');
const ASR = {
  model: process.env.LLAMA_ASR_MODEL ?? join(models, 'Qwen3-ASR-0.6B-Q8_0.gguf'),
  projector: process.env.LLAMA_ASR_MMPROJ ?? join(models, 'mmproj-Qwen3-ASR-0.6B-Q8_0.gguf'),
};

const DECODER = 'ffmpeg (scripts/ffmpeg-decoder.ts) in place of the page\'s WebCodecs; media\'s procedure did the rest';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** What a page asks of the host: how it composes a video, and to compose one. */
interface Host {
  describe(): Operation<VideoCapabilities>;
  compose(command: Extract<VideoCommand, { type: 'video:compose' }>): Operation<Extract<VideoEvent, { type: 'video:composed' }>>;
}

/** rig's video commands over an in-process wire: each command sent as a page sends it, and the answer it waits for. */
function* useHost(): Operation<Host> {
  const waiting = new Map<string, (event: VideoEvent) => void>();
  const group = yield* useVideoCommands({
    wire: {
      *send(event) {
        if (event.type === 'video:progress' && event.done % 50 === 0) process.stderr.write(`${event.requestId}: transcribed ${event.done} of ${event.total}\n`);
        waiting.get(event.type === 'video:capabilities' ? 'describe' : 'requestId' in event ? event.requestId : '')?.(event);
      },
    },
    config: () => ({ attachments: { video: VIDEO } }),
  });
  function* answer(key: string, command: VideoCommand, settles: (event: VideoEvent) => boolean): Operation<VideoEvent> {
    const answered = withResolvers<VideoEvent>();
    waiting.set(key, event => { if (settles(event)) answered.resolve(event); });
    try {
      yield* group.handlers[command.type]!(command as never);
      return yield* answered.operation;
    } finally {
      waiting.delete(key);
    }
  }
  return {
    *describe() {
      const event = yield* answer('describe', { type: 'video:describe' }, e => e.type === 'video:capabilities');
      return (event as Extract<VideoEvent, { type: 'video:capabilities' }>).capabilities;
    },
    *compose(command) {
      const event = yield* answer(command.requestId, command, e => e.type === 'video:composed' || e.type === 'video:error');
      if (event.type === 'video:error') throw new Error(`${command.requestId}: ${event.message}`);
      return event as Extract<VideoEvent, { type: 'video:composed' }>;
    },
  };
}

interface Pack {
  root: Attachment;
  source: { file: string; sha256: string; bytes: number };
  /** The policy the host described and composed under. */
  sampling: VideoCapabilities['sampling'];
  frames: number;
  soundtrackWindows: number;
  /** The windows the host could not transcribe, and why. */
  untranscribed: UntranscribedWindow[];
  decoder: string;
  builtAt: string;
}

function* composePack(store: FileAttachmentStore, host: Host, capabilities: VideoCapabilities, name: string, file: string): Operation<Pack> {
  const bytes = new Uint8Array(readFileSync(file));
  const ingress = createContentIngress(store);
  const log = (line: string) => process.stderr.write(`${name}: ${line}\n`);
  const decoder = ffmpegDecoder(file);
  const prepared = yield* call(() => prepareVideo(decoder, capabilities, frame => ingress.ingest(frame), {
    onProgress: p => { if (p.phase === 'ingesting' && p.done % 200 === 0) log(`ingested ${p.done} of ${p.total} frames`); },
  }).finally(() => decoder.dispose()));
  log(`${prepared.frames.length} frames and ${prepared.audio.length} soundtrack windows ingested`);
  const composed = yield* host.compose({
    type: 'video:compose', requestId: name, ...prepared, source: store.putBlob(bytes, sniffMediaType(bytes)),
  });
  log(`composed ${composed.root.digest}, ${composed.untranscribed.length} windows untranscribed`);
  return {
    root: composed.root,
    source: { file: basename(file), sha256: sha256(bytes), bytes: bytes.byteLength },
    sampling: capabilities.sampling,
    frames: prepared.frames.length,
    soundtrackWindows: prepared.audio.length,
    untranscribed: composed.untranscribed,
    decoder: DECODER,
    builtAt: new Date().toISOString(),
  };
}

main(function* (argv) {
  const [dir, ...named] = argv;
  const pairs = named.map(n => n.split(/=(.*)/s, 2) as [string, string]);
  // Each name is the compose request's id, which the host ignores unless it is one: checked before any ingest.
  if (!dir || pairs.length === 0 || pairs.some(([name, file]) => !/^[\w-]+$/.test(name) || !isRequestId(name) || !file)) {
    throw new Error('usage: scenario-pack.ts <store dir> <name>=<video> [<name>=<video> ...], each name a request id the host takes');
  }
  const store = new FileAttachmentStore(resolve(dir));
  const index = join(resolve(dir), 'packs.json');
  // Keyed by name as a map, so every name the check above accepts is a pack of its own, `__proto__` included.
  const packs = new Map<string, Pack>(existsSync(index) ? Object.entries(JSON.parse(readFileSync(index, 'utf8'))) : []);
  yield* Attachments.set(store);
  yield* Services.set({ transcription: yield* createTranscriber(ASR.model, ASR.projector) });
  const host = yield* useHost();
  const capabilities = yield* host.describe();
  for (const [name, file] of pairs) {
    packs.set(name, yield* composePack(store, host, capabilities, name, resolve(file)));
    writeFileSync(index, `${JSON.stringify(Object.fromEntries(packs), null, 2)}\n`);
  }
});
