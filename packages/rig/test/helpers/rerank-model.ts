/**
 * Where the weights-gated reranker tests find a Qwen3-Reranker GGUF: the
 * environment first, then the usual local homes. `null` skips the suite,
 * as the SDK's integration tests do without weights.
 *
 * @category Testing
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const RERANK_MODEL_PATH: string | null = [
  process.env.LLAMA_RERANK_MODEL,
  path.join(os.homedir(), '.cache/lloyal/models/qwen3-reranker-0.6b-q4_k_m.gguf'),
  path.join(os.homedir(), 'dev/apps/lloyal-node/models/qwen3-reranker-0.6b-q4_k_m.gguf'),
  path.join(os.homedir(), '.cache/lloyal/models/qwen3-reranker-0.6b-q8_0.gguf'),
].find((p): p is string => !!p && fs.existsSync(p)) ?? null;
