/**
 * Print what the Qwen3-Reranker's chat template actually produces under
 * `enableThinking: false` vs `true`. The HF model card shows the trained
 * format includes an empty `<think>\n\n</think>` block after the assistant
 * turn marker — we want to confirm whether our code's `enableThinking:false`
 * matches that or strips the block.
 *
 *   LLAMA_RERANK_MODEL=~/.cache/lloyal/models/qwen3-reranker-0.6b-q8_0.gguf \
 *     npx tsx test/__probe-rerank-prompt.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createContext } from '@lloyal-labs/lloyal.node';
import type { SessionContext } from '@lloyal-labs/sdk';

function resolveReranker(): string {
  const candidates = [
    process.env.LLAMA_RERANK_MODEL,
    path.join(os.homedir(), '.cache/lloyal/models/qwen3-reranker-0.6b-q8_0.gguf'),
    path.join(os.homedir(), '.cache/lloyal/models/qwen3-reranker-0.6b-q4_k_m.gguf'),
  ];
  for (const p of candidates) if (p && fs.existsSync(p)) return p;
  throw new Error('No reranker model found');
}

const SYSTEM_PROMPT =
  'Judge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".';
const USER_PREFIX =
  '<Instruct>: Given a web search query, retrieve relevant passages that answer the query\n\n<Query>: ';

async function main() {
  const modelPath = resolveReranker();
  console.log(`reranker: ${path.basename(modelPath)}\n`);
  const ctx = (await createContext({
    modelPath,
    nCtx: 1024,
    nSeqMax: 4,
    typeK: 'q4_0',
    typeV: 'q4_0',
  })) as unknown as SessionContext;

  const userTurn = `${USER_PREFIX}What is the capital of France?\n\n<Document>: Paris is the capital and most populous city of France.`;
  const messages = JSON.stringify([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userTurn },
  ]);

  for (const enableThinking of [false, true]) {
    console.log('═'.repeat(70));
    console.log(`enableThinking: ${enableThinking}`);
    console.log('═'.repeat(70));
    const probe = await ctx.formatChat(messages, {
      addGenerationPrompt: true,
      enableThinking,
    });
    console.log(probe.prompt);
    console.log('-'.repeat(70));
    const tokens = await ctx.tokenize(probe.prompt, true);
    console.log(`tokens: ${tokens.length}`);
    console.log(`contains "<think>": ${probe.prompt.includes('<think>')}`);
    console.log(`contains "</think>": ${probe.prompt.includes('</think>')}`);
    console.log();
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); });
