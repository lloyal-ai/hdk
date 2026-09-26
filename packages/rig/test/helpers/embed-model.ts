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
