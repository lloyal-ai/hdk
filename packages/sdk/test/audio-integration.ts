import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Branch, BranchStore, Session, buildUserDeltaMultimodal, deltaCells } from '@lloyal-labs/sdk';
import type { SessionContext, AudioLimits } from '@lloyal-labs/sdk';
import { createLocalContext, nativeRepo } from './local-native';

// Run explicitly with LLOYAL_LOCAL=1 and the SDK linked to this native checkout.
// Model and projector overrides must be a matching Qwen3-ASR pair.
const recording = readFileSync(resolve(nativeRepo, 'liblloyal/tests/fixtures/asr-counting.wav'));
const limits: AudioLimits = { maxBytes: 400_000, maxSamples: 200_000 };
const audio = (bytes: Uint8Array = recording) => ({ kind: 'audio' as const, bytes });
let ctx: SessionContext;
let store: BranchStore;

before(async () => {
  ctx = await createLocalContext({
    modelPath: process.env.LLAMA_ASR_MODEL ?? resolve(nativeRepo, 'models/audio/qwen3-asr/Qwen3-ASR-0.6B-Q8_0.gguf'),
    mmprojPath: process.env.LLAMA_ASR_MMPROJ ?? resolve(nativeRepo, 'models/audio/qwen3-asr/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf'),
    nCtx: 4096, nBatch: 128, nSeqMax: 8, nThreads: 4,
  });
  store = new BranchStore(ctx);
});

after(() => ctx?.dispose());

async function transcript(branch: Branch): Promise<string> {
  const tokens: number[] = [];
  for await (const { token } of branch) {
    tokens.push(token);
    assert.ok(tokens.length < 96, 'transcription reaches its stop token');
  }
  return ctx.detokenize(tokens);
}

function grounded(text: string): void {
  assert.match(text, /one, two, three, four, five/i);
  assert.match(text, /the meeting is on thursday/i);
  assert.match(text, /nine thirty|9:30/i);
}

test('public deltas own audio across measurement and prefill; forks inherit the projected prefix', async () => {
  assert.equal(ctx.supportsAudio(), true);
  assert.equal(ctx.supportsVision(), false);
  assert.equal(ctx.audioSampleRate(), 16000);
  const source = Buffer.from(recording);
  const delta = { ...buildUserDeltaMultimodal(ctx, '', [audio(source)], { audioLimits: limits, enableThinking: false }), sep: [] };
  const expected = await deltaCells(ctx, delta);
  assert.ok(expected > 0);
  assert.equal(ctx._storeKvPressure().cellsUsed, 0, 'measurement leaves KV untouched');
  source.fill(0);
  const parent = Branch.create(ctx, 0, { temperature: 0 });
  const children: Branch[] = [];
  try {
    const [result] = await store.prefillMultimodal([[parent, delta]]);
    assert.equal(result.error, undefined);
    assert.equal(result.tokensDecoded, expected);
    assert.equal(result.positionAdvance, expected);
    assert.equal(parent.position, expected);
    children.push(await parent.fork(), await parent.fork());
    assert.equal(ctx._storeKvPressure().cellsUsed, expected, 'forks share projected audio');
    for (const child of children) grounded(await transcript(child));
  } finally {
    children.forEach(child => child.pruneSync());
    parent.pruneSync();
  }
  assert.equal(ctx._storeKvPressure().cellsUsed, 0);
});

test('public admission rejects an invalid budget while its valid cohort sibling transcribes', async () => {
  const rejected = Branch.create(ctx, 0, { temperature: 0 });
  const valid = Branch.create(ctx, 0, { temperature: 0 });
  const delta = { ...buildUserDeltaMultimodal(ctx, '', [audio()], { audioLimits: limits, enableThinking: false }), sep: [] };
  const overBudget = { ...delta, audioLimits: { ...limits, maxSamples: 10 } };
  try {
    await assert.rejects(() => deltaCells(ctx, overBudget), /sample/i);
    const [failure, success] = await store.prefillMultimodal([[rejected, overBudget], [valid, delta]]);
    assert.match(failure.error ?? '', /sample/i);
    assert.equal(rejected.position, 0);
    assert.equal(success.error, undefined);
    grounded(await transcript(valid));
  } finally {
    rejected.pruneSync();
    valid.pruneSync();
  }
  assert.equal(ctx._storeKvPressure().cellsUsed, 0);
});

test('Session admits audio on a cold trunk and releases it after a failed warm prefill', async () => {
  const session = new Session({ ctx, store });
  try {
    await session.prefillUserMultimodal('', [audio()], { audioLimits: limits, enableThinking: false });
    assert.ok(session.trunk);
    const child = await session.trunk.fork();
    try { grounded(await transcript(child)); } finally { child.pruneSync(); }
    await assert.rejects(() => session.prefillUserMultimodal('', [audio()], {
      audioLimits: { ...limits, maxSamples: 10 }, enableThinking: false,
    }), /sample/i);
    assert.equal(session.trunk, null);
  } finally {
    await session.dispose();
  }
  assert.equal(ctx._storeKvPressure().cellsUsed, 0);
});
