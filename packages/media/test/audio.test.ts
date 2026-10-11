import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAttachmentStore } from '../src/file-store';
import { createContentIngress } from '../src/content-ingress';
import { materialize } from '../src/ingress';
import * as media from '../src/index';

import { pcmWav } from './fixtures/audio';

const roots: string[] = [];
function store() {
  const dir = mkdtempSync(join(tmpdir(), 'audio-media-'));
  roots.push(dir);
  return new FileAttachmentStore(dir);
}
afterEach(() => roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

describe('admitted audio', () => {
  it('sniffs WAV by RIFF and WAVE together', () => {
    expect(media.sniffMediaType(pcmWav())).toBe('audio/wav');
    const avi = pcmWav(); avi.set(new TextEncoder().encode('AVI '), 8);
    expect(media.sniffMediaType(avi)).toBe(media.UNKNOWN_MEDIA_TYPE);
  });

  it('stores the exact admitted representation with verifiable metadata, separately from image materialization', async () => {
    const content = store();
    const bytes = pcmWav({ channels: 2, rate: 48000 });
    const root = await createContentIngress(content).ingest(bytes);
    expect(await createContentIngress(content).ingest(bytes)).toEqual(root);
    const audio = media.resolveAudio(content, root);
    expect(audio.bytes).toEqual(bytes);
    expect(audio.metadata).toMatchObject({ channels: 2, sampleRate: 48000, frames: 160, bitsPerSample: 16, silent: false });
    expect(audio.representation.mediaType).toBe('audio/wav');
    expect(content.getManifest(root.digest)!.config.mediaType).toBe(media.AUDIO_CONFIG_TYPE);
    expect(materialize(content, [root]).bitmaps).toEqual([]);
  });

  it('identifies digital silence from samples, not from headers or the model output', async () => {
    const content = store();
    const root = await createContentIngress(content).ingest(pcmWav({ silent: true }));
    expect(media.resolveAudio(content, root).metadata.silent).toBe(true);
  });

  it.each([
    ['declared extent', (v: DataView) => v.setUint32(4, 0xffffffff, true)],
    ['truncated data', (v: DataView) => v.setUint32(40, 0xffffffff, true)],
    ['float WAV', (v: DataView) => v.setUint16(20, 3, true)],
    ['block alignment', (v: DataView) => v.setUint16(32, 3, true)],
    ['byte rate', (v: DataView) => v.setUint32(28, 1, true)],
  ])('refuses %s before committing anything', async (_name, mutate) => {
    const content = store();
    const write = vi.spyOn(content, 'putBlob');
    const bytes = pcmWav(); mutate(new DataView(bytes.buffer));
    await expect(createContentIngress(content).ingest(bytes)).rejects.toThrow(/WAV|PCM/i);
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    { maxBytes: 100 }, { maxDurationSeconds: 0.001 }, { maxSampleRate: 8000 },
  ])('enforces configured limits before commit: %j', async limits => {
    const content = store(); const write = vi.spyOn(content, 'putBlob');
    await expect(createContentIngress(content, { audio: limits }).ingest(pcmWav())).rejects.toThrow(/limit|exceed/i);
    expect(write).not.toHaveBeenCalled();
  });

  it('checks channels and abort before committing', async () => {
    const content = store(); const write = vi.spyOn(content, 'putBlob');
    await expect(createContentIngress(content, { audio: { maxChannels: 1 } }).ingest(pcmWav({ channels: 2 }))).rejects.toThrow(/channel/i);
    const cancelled = AbortSignal.abort();
    await expect(createContentIngress(content).ingest(pcmWav(), cancelled)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses missing or mismatched representations and applies current limits again at resolution', async () => {
    const content = store();
    const root = await createContentIngress(content).ingest(pcmWav());
    expect(() => media.resolveAudio(content, root, { maxBytes: 100 })).toThrow(/limit|exceed/i);
    const get = content.get.bind(content);
    const rep = media.resolveAudio(content, root).representation;
    vi.spyOn(content, 'get').mockImplementation(digest => digest === rep.digest ? null : get(digest));
    expect(() => media.resolveAudio(content, root)).toThrow(/missing|digest/i);
  });
});
