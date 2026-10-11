import { representationsOf } from './attachment';
import type { Attachment, Descriptor } from './attachment';
import type { AttachmentStore } from './store';

export const AUDIO_CONFIG_TYPE = 'application/vnd.lloyal.audio.v1+json' as const;
export const AUDIO_MEDIA_TYPE = 'audio/wav' as const;

/** Admission limits; conversion to the projector's rate remains the native decoder's responsibility. */
export interface AudioAdmission {
  maxBytes: number;
  maxDurationSeconds: number;
  maxChannels: number;
  maxSampleRate: number;
}

export const DEFAULT_AUDIO_ADMISSION: Readonly<AudioAdmission> = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxDurationSeconds: 60,
  maxChannels: 2,
  maxSampleRate: 48_000,
});

export interface AudioMeta {
  format: 'pcm';
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  frames: number;
  durationSeconds: number;
  /** Exact digital silence. This is not a voice activity detector. */
  silent: boolean;
}

export interface AdmittedAudio {
  attachment: Attachment;
  representation: Descriptor;
  metadata: AudioMeta;
  bytes: Uint8Array;
}

export function audioAdmission(overrides: Partial<AudioAdmission> = {}): AudioAdmission {
  const specified = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
  const limits = { ...DEFAULT_AUDIO_ADMISSION, ...specified };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0 || (key !== 'maxDurationSeconds' && !Number.isSafeInteger(value))) {
      throw new Error(`audio limit ${key} must be a positive ${key === 'maxDurationSeconds' ? 'number' : 'safe integer'}`);
    }
  }
  return limits;
}

/** Inspect integer PCM framing before storage or native allocation; no decoding or resampling occurs here. */
export function inspectPcmWav(bytes: Uint8Array, overrides: Partial<AudioAdmission> = {}): AudioMeta {
  const limits = audioAdmission(overrides);
  if (bytes.byteLength > limits.maxBytes) throw new Error('audio exceeds the encoded byte limit');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number, expected: string): boolean =>
    at + 4 <= bytes.length && [...expected].every((char, i) => bytes[at + i] === char.charCodeAt(0));
  if (bytes.length < 12 || !tag(0, 'RIFF') || !tag(8, 'WAVE') || view.getUint32(4, true) !== bytes.length - 8) {
    throw new Error('invalid PCM WAV container');
  }

  let format: DataView | undefined;
  let samples: Uint8Array | undefined;
  for (let offset = 12; offset < bytes.length;) {
    if (bytes.length - offset < 8) throw new Error('truncated WAV chunk');
    const length = view.getUint32(offset + 4, true);
    const end = offset + 8 + length;
    if (end + (length & 1) > bytes.length) throw new Error('truncated WAV chunk');
    if (tag(offset, 'fmt ')) {
      if (format || (length !== 16 && length !== 18)) throw new Error('invalid WAV format chunk');
      format = new DataView(bytes.buffer, bytes.byteOffset + offset + 8, length);
    } else if (tag(offset, 'data')) {
      if (!format || samples) throw new Error('invalid WAV data chunk');
      samples = bytes.subarray(offset + 8, end);
    } else if (!tag(offset, 'JUNK') && !(tag(offset, 'LIST') && length >= 4 && tag(offset + 8, 'INFO'))) {
      throw new Error('unsupported WAV chunk');
    }
    offset = end + (length & 1);
  }
  if (!format || !samples || format.getUint16(0, true) !== 1 || (format.byteLength === 18 && format.getUint16(16, true) !== 0)) {
    throw new Error('expected integer PCM WAV');
  }
  const channels = format.getUint16(2, true);
  const sampleRate = format.getUint32(4, true);
  const bitsPerSample = format.getUint16(14, true);
  const alignment = channels * bitsPerSample / 8;
  if (!channels || !sampleRate || ![8, 16, 24, 32].includes(bitsPerSample) ||
      format.getUint16(12, true) !== alignment || format.getUint32(8, true) !== sampleRate * alignment || samples.length % alignment !== 0) {
    throw new Error('inconsistent PCM WAV format');
  }
  const frames = samples.length / alignment;
  const durationSeconds = frames / sampleRate;
  if (frames < 2) throw new Error('PCM WAV needs at least two sample frames');
  if (channels > limits.maxChannels) throw new Error('audio exceeds the channel limit');
  if (sampleRate > limits.maxSampleRate) throw new Error('audio exceeds the sample rate limit');
  if (durationSeconds > limits.maxDurationSeconds) throw new Error('audio exceeds the duration limit');
  const silent = samples.every(sample => sample === (bitsPerSample === 8 ? 128 : 0));
  return { format: 'pcm', channels, sampleRate, bitsPerSample, frames, durationSeconds, silent };
}

export function asAudioMeta(value: unknown): AudioMeta | null {
  if (!value || typeof value !== 'object') return null;
  const m = value as AudioMeta;
  const positive = [m.channels, m.sampleRate, m.bitsPerSample, m.frames].every(n => Number.isSafeInteger(n) && n > 0);
  return m.format === 'pcm' && positive && [8, 16, 24, 32].includes(m.bitsPerSample) &&
    m.frames >= 2 && m.durationSeconds === m.frames / m.sampleRate && typeof m.silent === 'boolean' ? m : null;
}

/** Resolve the admitted representation, rechecking both its digest and the caller's current admission limits. */
export function resolveAudio(store: AttachmentStore, attachment: Attachment, limits: Partial<AudioAdmission> = {}): AdmittedAudio {
  const bounds = audioAdmission(limits);
  const manifest = store.getManifest(attachment.digest);
  if (!manifest || manifest.config.mediaType !== AUDIO_CONFIG_TYPE) throw new Error('missing audio manifest or invalid digest');
  const representations = representationsOf(manifest);
  if (representations.length !== 1 || representations[0].mediaType !== AUDIO_MEDIA_TYPE) throw new Error('invalid audio representation');
  const representation = representations[0];
  if (representation.size > bounds.maxBytes) throw new Error('audio exceeds the encoded byte limit');
  if (manifest.config.size > 1024) throw new Error('audio metadata exceeds its size limit');
  const bytes = store.get(representation.digest);
  const config = store.get(manifest.config.digest);
  if (!bytes || !config || bytes.length !== representation.size || config.length !== manifest.config.size) {
    throw new Error('missing audio content or invalid digest');
  }
  const metadata = inspectPcmWav(bytes, bounds);
  const recorded = asAudioMeta(JSON.parse(new TextDecoder().decode(config)));
  if (!recorded || (Object.keys(metadata) as (keyof AudioMeta)[]).some(key => recorded[key] !== metadata[key])) {
    throw new Error('audio metadata does not match the admitted representation');
  }
  return { attachment: { ...attachment }, representation, bytes, metadata };
}
