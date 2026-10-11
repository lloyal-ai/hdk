import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run } from 'effection';
import { createAudioIngress, FileAttachmentStore } from '@lloyal-labs/media/node';
import { pcmWav } from '../../media/test/fixtures/audio';
import { createTranscriber } from '../src/providers/transcription';
import { nativeRepo, verifyLocalNative } from '../../sdk/test/local-native';

test('resident Qwen3-ASR transcribes admitted audio and bypasses exact silence', async () => {
  verifyLocalNative();
  const dir = mkdtempSync(join(tmpdir(), 'rig-asr-real-'));
  const store = new FileAttachmentStore(dir);
  const ingress = createAudioIngress(store);
  const speech = readFileSync(resolve(nativeRepo, 'liblloyal/tests/fixtures/asr-counting.wav'));
  const repeated = readFileSync(resolve(nativeRepo, 'liblloyal/tests/fixtures/asr-repeated.wav'));
  const silent = pcmWav({ frames: 32_000, silent: true });
  const roots = await Promise.all([speech, repeated, silent].map(bytes => ingress.ingest(bytes)));
  try {
    await run(function* () {
      const service = yield* createTranscriber(
        process.env.LLAMA_ASR_MODEL ?? resolve(nativeRepo, 'models/audio/qwen3-asr/Qwen3-ASR-0.6B-Q8_0.gguf'),
        process.env.LLAMA_ASR_MMPROJ ?? resolve(nativeRepo, 'models/audio/qwen3-asr/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf'),
        { store },
      );
      verifyLocalNative({ loaded: true });
      for (const root of roots.slice(0, 2)) {
        const start = performance.now();
        const result = yield* service.transcribe(root);
        console.log(JSON.stringify({ text: result.text, language: result.language, durationMs: performance.now() - start }));
        assert.match(result.text, /one, two, three, four, five/i);
        assert.match(result.text, /the meeting is on thursday/i);
        assert.match(result.text, /nine thirty|9:30/i);
        assert.equal(result.language, 'English');
        assert.equal(result.silent, false);
        if (root === roots[1]) assert.equal(result.text.match(/the meeting is on thursday/ig)?.length, 2);
      }
      const silence = yield* service.transcribe(roots[2]);
      assert.equal(silence.text, ''); assert.equal(silence.language, undefined); assert.equal(silence.silent, true);
      const next = yield* service.transcribe(roots[0]);
      assert.match(next.text, /one, two, three, four, five/i);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
