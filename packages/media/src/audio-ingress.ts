import { AUDIO_CONFIG_TYPE, AUDIO_MEDIA_TYPE, audioAdmission, inspectPcmWav } from './audio';
import type { AudioAdmission } from './audio';
import type { ContentIngress } from './ingress';
import type { AttachmentStore } from './store';

export interface AudioIngressOptions extends Partial<AudioAdmission> {
  /** Lifetime policy belongs to the store owner; durable is the currently supported mode. */
  retention?: 'durable';
}

export function createAudioIngress(store: AttachmentStore, opts: AudioIngressOptions = {}): ContentIngress {
  const { retention = 'durable', ...overrides } = opts;
  if (retention !== 'durable') throw new Error('unsupported audio retention policy');
  const limits = audioAdmission(overrides);
  return {
    async ingest(bytes, signal) {
      signal?.throwIfAborted();
      const metadata = inspectPcmWav(bytes, limits);
      signal?.throwIfAborted();
      return store.putAttachment({
        representations: [store.putBlob(bytes, AUDIO_MEDIA_TYPE)],
        config: { mediaType: AUDIO_CONFIG_TYPE, bytes: new TextEncoder().encode(JSON.stringify(metadata)) },
      });
    },
  };
}
