import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Branch, BranchStore, Session, buildToolResultDeltaMultimodal, buildUserDeltaMultimodal, deltaCells } from '@lloyal-labs/sdk';
import type { MultimodalInput, SessionContext } from '@lloyal-labs/sdk';
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

// A video is one typed input: its sampled frames, their times and the
// timestamp interval. liblloyal lays it out as llama.cpp's video helper does.
const videoDir = resolve(nativeRepo, 'liblloyal/tests/fixtures/video');
const clipFrames = Array.from({ length: 16 }, (_, i) =>
  readFileSync(resolve(videoDir, `frame-${String(i).padStart(2, '0')}.png`)));
const clip = (): MultimodalInput => ({
  kind: 'video', frames: clipFrames, timestampsMs: clipFrames.map((_, i) => i * 250), timestampIntervalMs: 5000,
});
const DIRECTION = 'Which direction does the red square move? Answer in a few words.';

test('a video costs what it lands, keeps M-RoPE accounting and answers on motion', async () => {
  const delta = { ...buildUserDeltaMultimodal(ctx, DIRECTION, [clip()], { enableThinking: false }), sep: [] };
  const cells = await deltaCells(ctx, delta);
  const branch = Branch.create(ctx, 0, { temperature: 0 });
  try {
    const result = await branch.prefillMultimodal(delta.prompt, delta.bitmaps, delta.sep);
    assert.equal(result.tokensDecoded, cells);
    assert.ok(result.positionAdvance < cells, 'fused frames retain M-RoPE accounting');
    assert.match(await answer(branch), /right/i);
  } finally { branch.pruneSync(); }
  assert.equal(ctx._storeKvPressure().cellsUsed, 0);
});

test('a video reaches the store cohort and the session trunk unchanged', async () => {
  const delta = { ...buildUserDeltaMultimodal(ctx, DIRECTION, [clip()], { enableThinking: false }), sep: [] };
  const branch = Branch.create(ctx, 0, { temperature: 0 });
  try {
    const [result] = await new BranchStore(ctx).prefillMultimodal([[branch, delta]]);
    assert.equal(result.error, undefined);
    assert.match(await answer(branch), /right/i);
  } finally { branch.pruneSync(); }

  const session = new Session({ ctx, store: new BranchStore(ctx) });
  try {
    await session.prefillUserMultimodal(DIRECTION, [clip()], { enableThinking: false });
    assert.ok(session.trunk);
    // The cold trunk samples with defaults; a grounded check needs it greedy.
    session.trunk.setSamplerParams({ temperature: 0 });
    assert.match(await answer(session.trunk), /right/i);
  } finally { await session.dispose(); }
  assert.equal(ctx._storeKvPressure().cellsUsed, 0);
});

test('a video delta owns its frames: caller mutation after building changes nothing admitted', async () => {
  const frames = clipFrames.map(f => new Uint8Array(f));
  const times = frames.map((_, i) => i * 250);
  const input: MultimodalInput = { kind: 'video', frames, timestampsMs: times };
  const delta = { ...buildUserDeltaMultimodal(ctx, DIRECTION, [input], { enableThinking: false }), sep: [] };
  const before = await deltaCells(ctx, delta);
  frames[0].fill(0);
  frames.pop();
  times.reverse();
  assert.equal(await deltaCells(ctx, delta), before);
});

test('a tool result can carry a video', async () => {
  const delta = buildToolResultDeltaMultimodal(ctx, 'The clip you asked for.', 'call-1', [clip()], { enableThinking: false });
  assert.equal(delta.prompt.split('<__media__>').length - 1, 1, 'one marker for the whole video');
  assert.ok(await deltaCells(ctx, delta) > 0);
});
