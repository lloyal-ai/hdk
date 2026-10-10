import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Branch, BranchStore, Session, buildUserDeltaMultimodal, deltaCells } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';
import { createLocalContext, nativeRepo } from './local-native';

const image = readFileSync(resolve(nativeRepo, 'test/fixtures/red-square-blue-circle.png'));
let ctx: SessionContext;

before(async () => {
  ctx = await createLocalContext({
    modelPath: process.env.LLAMA_VL_MODEL ?? resolve(nativeRepo, 'models/Qwen3.5-4B-Q4_K_M.gguf'),
    mmprojPath: process.env.LLAMA_VL_MMPROJ ?? resolve(nativeRepo, 'models/mmproj-Qwen3.5-4B-F16.gguf'),
    nCtx: 4096, nBatch: 256, nSeqMax: 4, nThreads: 4, typeK: 'q4_0', typeV: 'q4_0',
  });
});
after(() => ctx?.dispose());

async function answer(branch: Branch): Promise<string> {
  const tokens: number[] = [];
  for await (const { token } of branch) {
    tokens.push(token);
    assert.ok(tokens.length < 64, 'one-word answer reaches its stop token');
  }
  return ctx.detokenize(tokens);
}

test('legacy image calls retain measured cells, M-RoPE positions and grounded output', async () => {
  assert.equal(ctx.supportsVision(), true);
  assert.equal(ctx.supportsAudio(), false);
  assert.equal(ctx.audioSampleRate(), 0);
  const delta = { ...buildUserDeltaMultimodal(ctx, 'What color is the square? Answer in one word.', [image], { enableThinking: false }), sep: [] };
  const cells = await deltaCells(ctx, delta);
  const branch = Branch.create(ctx, 0, { temperature: 0 });
  try {
    const result = await branch.prefillMultimodal(delta.prompt, delta.bitmaps, delta.sep);
    assert.equal(result.tokensDecoded, cells);
    assert.ok(result.positionAdvance < cells, 'image rows retain M-RoPE accounting');
    assert.match(await answer(branch), /red/i);
  } finally { branch.pruneSync(); }
  assert.equal(ctx._storeKvPressure().cellsUsed, 0);
});

test('typed images use the same store prefill rail without audio limits', async () => {
  const delta = { ...buildUserDeltaMultimodal(ctx, 'What color is the circle? Answer in one word.', [{ kind: 'image', bytes: image }], { enableThinking: false }), sep: [] };
  const branch = Branch.create(ctx, 0, { temperature: 0 });
  try {
    const [result] = await new BranchStore(ctx).prefillMultimodal([[branch, delta]]);
    assert.equal(result.error, undefined);
    assert.match(await answer(branch), /blue/i);
  } finally { branch.pruneSync(); }
  assert.equal(ctx._storeKvPressure().cellsUsed, 0);
});

test('the image session call still creates an attended cold trunk', async () => {
  const session = new Session({ ctx, store: new BranchStore(ctx) });
  try {
    await session.prefillUserMultimodal('What shape is blue? Answer in one word.', [image], { enableThinking: false });
    assert.ok(session.trunk);
    assert.match(await answer(session.trunk), /circle/i);
  } finally { await session.dispose(); }
  assert.equal(ctx._storeKvPressure().cellsUsed, 0);
});
