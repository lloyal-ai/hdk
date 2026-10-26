/**
 * Where the weights-gated embedder tests find an embedding GGUF: the environment first, then the fixture the
 * native runtime's own integration test uses. `null` skips the suite, as the reranker suites do without weights.
 *
 * @category Testing
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { nativeRepo } from '../../../sdk/test/local-native';

/** nomic-embed-text v1.5 Q4_K_M — mean pooling, 768 dimensions. */
export const NOMIC_MODEL_PATH: string | null = [
  process.env.LLAMA_EMBED_MODEL,
  path.join(nativeRepo, 'models/nomic-embed-text-v1.5.Q4_K_M.gguf'),
  path.join(nativeRepo, 'liblloyal/tests/fixtures/nomic-embed-text-v1.5.Q4_K_M.gguf'),
  path.join(os.homedir(), '.cache/lloyal/models/nomic-embed-text-v1.5.Q4_K_M.gguf'),
].find((p): p is string => !!p && fs.existsSync(p)) ?? null;

/** EmbeddingGemma 2 Q8_0 and its vision and audio projector, with the reference vectors llama.cpp's server made
 *  for the native runtime's fixtures. The suite holds a gigabyte of projector on the GPU, so it runs only when
 *  asked, in a process of its own beside no other model's suite:
 *  `LLOYAL_LOCAL=1 LLOYAL_EMBED_MM_TEST=1 npx vitest run packages/rig/test/embedder-multimodal-model.test.ts`.
 *  `null` skips it otherwise, or without the files. */
export const EMBEDDINGGEMMA: { model: string; projector: string; fixtures: string } | null = (() => {
  if (process.env.LLOYAL_EMBED_MM_TEST !== '1') return null;
  const model = process.env.LLAMA_EMBED_MM_MODEL ?? path.join(nativeRepo, 'models/embeddinggemma-2/embeddinggemma-2-Q8_0.gguf');
  const projector = process.env.LLAMA_EMBED_MM_MMPROJ ?? path.join(nativeRepo, 'models/embeddinggemma-2/mmproj-BF16.gguf');
  const fixtures = path.join(nativeRepo, 'liblloyal/tests/fixtures');
  return [model, projector, path.join(fixtures, 'embedding/embeddinggemma2-reference.json')].every((p) => fs.existsSync(p))
    ? { model, projector, fixtures }
    : null;
})();
