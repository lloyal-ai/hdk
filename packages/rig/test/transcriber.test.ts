import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { call, run, sleep, spawn } from 'effection';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockSessionContext } from '../../sdk/src/testing';
import { FileAttachmentStore } from '../../media/src/file-store';
import { createAudioIngress } from '../../media/src/audio-ingress';
import type { Attachment } from '@lloyal-labs/media';
import { pcmWav } from '../../media/test/fixtures/audio';
import { createTranscriber } from '../src/providers/transcription';

const { createContext } = vi.hoisted(() => ({ createContext: vi.fn() }));
vi.mock('@lloyal-labs/sdk/node', () => ({ createContext }));
let ctx: MockSessionContext;
let content: FileAttachmentStore;
let root: Attachment;
let dir: string;
const events: string[] = [];


beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'asr-service-')); content = new FileAttachmentStore(dir);
  root = await createAudioIngress(content).ingest(pcmWav());
  ctx = new MockSessionContext({ nCtx: 4096, nSeqMax: 1 }); ctx.mockAudioSampleRate = 16000;
  const seen = new Set<number>();
  ctx._branchSample = handle => { if (seen.has(handle)) return ctx.stopToken; seen.add(handle); return 7; };
  ctx.tokenToBytes = () => new TextEncoder().encode('language English<asr_text>Hello world.');
  createContext.mockReset(); createContext.mockResolvedValue(ctx); events.length = 0;
  const prefill = ctx._storePrefillMultimodal.bind(ctx);
  vi.spyOn(ctx, '_storePrefillMultimodal').mockImplementation(async (...args) => { events.push('prefill'); return prefill(...args); });
  const prune = ctx._branchPrune.bind(ctx);
  vi.spyOn(ctx, '_branchPrune').mockImplementation(handle => { events.push('prune'); return prune(handle); });
  const dispose = ctx.dispose.bind(ctx);
  vi.spyOn(ctx, 'dispose').mockImplementation(() => { events.push('dispose'); dispose(); });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the owned transcription service', () => {
  it('loads its pair, returns text and provenance from admitted audio, and frees each request history', async () => {
    await run(function* () {
      const asr = yield* createTranscriber('/asr.gguf', '/projector.gguf', { store: content });
      const a = yield* asr.transcribe(root); const b = yield* asr.transcribe(root);
      expect(a).toMatchObject({ text: 'Hello world.', language: 'English', audio: root, silent: false });
      expect(b.text).toBe(a.text);
      expect(ctx.cellsUsed).toBe(0);
    });
    expect(createContext).toHaveBeenCalledWith(expect.objectContaining({ modelPath: '/asr.gguf', mmprojPath: '/projector.gguf', nSeqMax: 1 }));
    expect(events).toEqual(['prefill', 'prune', 'prefill', 'prune', 'dispose']);
    expect(ctx.disposeCount).toBe(1);
  });

  it('returns empty text for exact silence without projecting or generating', async () => {
    const silent = await createAudioIngress(content).ingest(pcmWav({ silent: true }));
    const result = await run(function* () {
      const asr = yield* createTranscriber('/asr.gguf', '/p.gguf', { store: content });
      return yield* asr.transcribe(silent);
    });
    expect(result).toMatchObject({ text: '', silent: true });
    expect(result.language).toBeUndefined();
    expect(events).toEqual(['dispose']);
  });

  it('a cancelled queued request does no inference and cannot let another caller overtake native work', async () => {
    let release!: () => void; const parked = new Promise<void>(r => { release = r; });
    const prefill = ctx._storePrefillMultimodal.bind(ctx);
    vi.spyOn(ctx, '_storePrefillMultimodal').mockImplementationOnce(async (...args) => { events.push('started'); await parked; return prefill(...args); });
    await run(function* () {
      const asr = yield* createTranscriber('/asr.gguf', '/p.gguf', { store: content });
      const first = yield* spawn(() => asr.transcribe(root));
      yield* sleep(0);
      const cancelled = yield* spawn(() => asr.transcribe(root));
      yield* cancelled.halt();
      const last = yield* spawn(() => asr.transcribe(root));
      yield* sleep(0);
      expect(events).toEqual(['started']);
      release(); yield* first; yield* last;
    });
    expect(events.filter(e => e === 'prefill')).toHaveLength(2);
  });

  it('in-flight cancellation settles before prune and shutdown; no cancelled result escapes', async () => {
    let release!: () => void; const pending = new Promise<void>(r => { release = r; });
    const prefill = ctx._storePrefillMultimodal.bind(ctx);
    vi.spyOn(ctx, '_storePrefillMultimodal').mockImplementationOnce(async (...args) => { events.push('started'); await pending; events.push('settled'); return prefill(...args); });
    let answered = false;
    const owner = run(function* () {
      const asr = yield* createTranscriber('/asr.gguf', '/p.gguf', { store: content });
      yield* asr.transcribe(root); answered = true;
    });
    await new Promise(r => setTimeout(r, 10));
    const halted = owner.halt();
    expect(events).toEqual(['started']);
    release(); await halted;
    expect(answered).toBe(false);
    expect(events).toEqual(['started', 'settled', 'prefill', 'prune', 'dispose']);
  });

  it('rejects truncated output and permits the next request after failure', async () => {
    await run(function* () {
      const asr = yield* createTranscriber('/asr.gguf', '/p.gguf', { store: content, maxTokens: 1 });
      ctx._branchSample = () => 7;
      let failure: unknown;
      try { yield* asr.transcribe(root); } catch (err) { failure = err; }
      expect(String(failure)).toMatch(/token limit/i);
      expect(ctx.cellsUsed).toBe(0);
      let sampled = false;
      ctx._branchSample = () => sampled ? ctx.stopToken : (sampled = true, 7);
      expect((yield* asr.transcribe(root)).text).toBe('Hello world.');
    });
  });

  it('refuses a context without an audio projector and disposes the failed acquisition', async () => {
    ctx.mockAudioSampleRate = 0;
    await expect(run(() => createTranscriber('/asr.gguf', '/p.gguf', { store: content }))).rejects.toThrow(/audio projector/);
    expect(ctx.disposeCount).toBe(1);
  });
});
