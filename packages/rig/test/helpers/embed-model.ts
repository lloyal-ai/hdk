/**
 * Where the weights-gated embedder tests find an embedding GGUF: the environment first, then the fixture the
 * native runtime's own integration test uses. `null` skips the suite, as the reranker suites do without weights.
 *
 * @category Testing
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** nomic-embed-text v1.5 Q4_K_M — mean pooling, 768 dimensions. */
export const NOMIC_MODEL_PATH: string | null = [
  process.env.LLAMA_EMBED_MODEL,
  path.join(os.homedir(), 'dev/apps/lloyal-node/models/nomic-embed-text-v1.5.Q4_K_M.gguf'),
  path.join(os.homedir(), 'dev/apps/lloyal-node/liblloyal/tests/fixtures/nomic-embed-text-v1.5.Q4_K_M.gguf'),
  path.join(os.homedir(), '.cache/lloyal/models/nomic-embed-text-v1.5.Q4_K_M.gguf'),
].find((p): p is string => !!p && fs.existsSync(p)) ?? null;

const lloyalNode = path.join(os.homedir(), 'dev/apps/lloyal-node');

/** EmbeddingGemma 2 Q8_0 and its vision and audio projector, with the reference vectors llama.cpp's server made
 *  for the native runtime's fixtures. `null` skips the suite without them. */
export const EMBEDDINGGEMMA: { model: string; projector: string; fixtures: string } | null = (() => {
  const model = process.env.LLAMA_EMBED_MM_MODEL ?? path.join(lloyalNode, 'models/embeddinggemma-2/embeddinggemma-2-Q8_0.gguf');
  const projector = process.env.LLAMA_EMBED_MM_MMPROJ ?? path.join(lloyalNode, 'models/embeddinggemma-2/mmproj-BF16.gguf');
  const fixtures = path.join(lloyalNode, 'liblloyal/tests/fixtures');
  return [model, projector, path.join(fixtures, 'embedding/embeddinggemma2-reference.json')].every((p) => fs.existsSync(p))
    ? { model, projector, fixtures }
    : null;
})();
