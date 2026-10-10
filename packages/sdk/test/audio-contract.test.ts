import { describe, expect, it, vi } from 'vitest';
import { Branch, BranchStore, Session, buildUserDeltaMultimodal, buildToolResultDeltaMultimodal, deltaCells } from '../src/index';
import type { AudioLimits, MultimodalInput } from '../src/types';
import { MockSessionContext } from '../src/testing';

const audio = (): MultimodalInput => ({ kind: 'audio', bytes: Buffer.from([1, 2, 3]) });
const limits = (): AudioLimits => ({ maxBytes: 1024, maxSamples: 16000 });

describe('typed audio through the SDK', () => {
  it('does not coerce unsupported audio views into accepted bytes', () => {
    const ctx = new MockSessionContext();
    const input = { kind: 'audio' as const, bytes: new Int32Array([1]) as unknown as Uint8Array };
    expect(() => buildUserDeltaMultimodal(ctx, '', [input], { audioLimits: limits() })).toThrow(/Uint8Array|Buffer/);
  });

  it.each(['user', 'tool'] as const)('%s deltas reject aggregate audio byte overflow before copying', role => {
    const ctx = new MockSessionContext();
    const inputs = [audio(), audio()];
    const build = (audioLimits?: AudioLimits) => role === 'user'
      ? buildUserDeltaMultimodal(ctx, '', inputs, { audioLimits })
      : buildToolResultDeltaMultimodal(ctx, '', 'call_1', inputs, { audioLimits });
    expect(() => build()).toThrow(/limit|budget/i);
    expect(() => build({ maxBytes: 5, maxSamples: 16000 })).toThrow(/byte/i);
    expect(() => build({ maxBytes: NaN, maxSamples: 16000 })).toThrow(/limit|budget/i);
  });

  it('models linear audio positions separately from image positions', async () => {
    const ctx = new MockSessionContext();
    ctx.mockAudioSampleRate = 16000;
    expect(ctx.supportsAudio()).toBe(true);
    expect(ctx.audioSampleRate()).toBe(16000);
    const branch = Branch.create(ctx, 0);
    const result = await branch.prefillMultimodal('<__media__>', [audio()], [], limits());
    expect(result.tokensDecoded).toBeGreaterThan(0);
    expect(result.positionAdvance).toBe(result.tokensDecoded);
    await branch.prune();
    expect(ctx.cellsUsed).toBe(0);
  });

  it('forwards the single-branch budget and preserves failure classification', async () => {
    const ctx = new MockSessionContext();
    const prefill = vi.spyOn(ctx, '_storePrefillMultimodal');
    const branch = Branch.create(ctx, 0);
    const inputs = [audio()];
    const budget = limits();
    await branch.prefillMultimodal('<__media__>', inputs, [7], budget);
    expect(prefill).toHaveBeenCalledWith([branch.handle], [[7]], ['<__media__>'], [inputs], [budget]);
    ctx.mockMultimodalError = () => ({ message: 'decode failed', rc: -3, partial: true });
    await expect(branch.prefillMultimodal('<__media__>', inputs, [], budget))
      .rejects.toMatchObject({ rc: -3, partial: true });
    await branch.prune();
  });

  it.each(['user', 'tool'] as const)('%s deltas own the bytes and limits shared by measurement and prefill', async role => {
    const ctx = new MockSessionContext();
    const inputs: MultimodalInput[] = [audio(), new Uint8Array([4, 5])];
    const budget = limits();
    const expectedInputs = [{ kind: 'audio', bytes: new Uint8Array([1, 2, 3]) }, new Uint8Array([4, 5])];
    const expectedBudget = limits();
    const opts = { audioLimits: budget, enableThinking: false };
    const delta = role === 'user'
      ? buildUserDeltaMultimodal(ctx, 'literal <__media__>', inputs, opts)
      : buildToolResultDeltaMultimodal(ctx, 'literal <__media__>', 'call_1', inputs, opts);
    const measure = vi.spyOn(ctx, '_cellsMultimodal');
    const prefill = vi.spyOn(ctx, '_storePrefillMultimodal');
    const sourceAudio = inputs[0] as Exclude<MultimodalInput, Uint8Array>;
    sourceAudio.bytes.fill(9);
    sourceAudio.kind = 'image';
    (inputs[1] as Uint8Array).fill(9);
    inputs.length = 0;
    budget.maxSamples = 1;

    const cells = await deltaCells(ctx, delta);
    const branch = Branch.create(ctx, 0);
    const [result] = await new BranchStore(ctx).prefillMultimodal([[branch, delta]]);
    expect(measure).toHaveBeenCalledWith(delta.sep, delta.prompt, expectedInputs, expectedBudget);
    expect(prefill).toHaveBeenCalledWith([branch.handle], [delta.sep], [delta.prompt], [expectedInputs], [expectedBudget]);
    expect(delta.prompt.match(/<__media__>/g)).toHaveLength(2);
    expect(result.tokensDecoded).toBe(cells);
    await branch.prune();
    expect(ctx.cellsUsed).toBe(0);
  });

  it('keeps cohort budgets aligned across images, rejected audio, and successful audio', async () => {
    const ctx = new MockSessionContext();
    const prefill = vi.spyOn(ctx, '_storePrefillMultimodal');
    const store = new BranchStore(ctx);
    const branches = [0, 1, 2].map(() => Branch.create(ctx, 0));
    const deltas = [
      buildUserDeltaMultimodal(ctx, 'image', [new Uint8Array([1])]),
      buildUserDeltaMultimodal(ctx, 'reject', [audio()], { audioLimits: limits() }),
      buildUserDeltaMultimodal(ctx, 'audio', [audio()], { audioLimits: { maxBytes: 2048, maxSamples: 32000 } }),
    ];
    ctx.mockMultimodalError = prompt => prompt.includes('reject') ? { message: 'invalid audio', rc: -1, partial: false } : null;
    const results = await store.prefillMultimodal(branches.map((branch, i) => [branch, deltas[i]]));
    expect(prefill.mock.calls[0][4]).toEqual([undefined, limits(), { maxBytes: 2048, maxSamples: 32000 }]);
    expect(results[0].tokensDecoded).toBeGreaterThan(0);
    expect(results[1]).toMatchObject({ error: 'invalid audio', rc: -1, partial: false });
    expect(branches[1].position).toBe(0);
    expect(results[2].tokensDecoded).toBeGreaterThan(0);
    branches.forEach(branch => branch.pruneSync());
    expect(ctx.cellsUsed).toBe(0);
  });

  it('threads audio options through cold and warm session turns and reclaims failed trunks', async () => {
    const ctx = new MockSessionContext({ nSeqMax: 4 });
    const prefill = vi.spyOn(ctx, '_storePrefillMultimodal');
    const format = vi.spyOn(ctx, 'formatChatSync');
    const session = new Session({ ctx, store: new BranchStore(ctx) });
    const opts = { audioLimits: limits(), enableThinking: false };
    await session.prefillUserMultimodal('', [audio()], opts);
    expect(prefill.mock.calls[0][1]).toEqual([[]]);
    expect(prefill.mock.calls[0][4]).toEqual([limits()]);
    expect(format.mock.calls[0][1]).toMatchObject({ enableThinking: false });
    await session.prefillUserMultimodal('', [audio()], opts);
    expect(prefill.mock.calls[1][1]).toEqual([ctx.getTurnSeparator()]);
    expect(prefill.mock.calls[1][4]).toEqual([limits()]);

    const admittedTrunk = session.trunk;
    await expect(session.prefillUserMultimodal('', [audio()], { audioLimits: { ...limits(), maxBytes: 1 } })).rejects.toThrow(/byte/i);
    expect(session.trunk).toBe(admittedTrunk);
    expect(prefill).toHaveBeenCalledTimes(2);

    ctx.mockMultimodalError = () => ({ message: 'partial decode', rc: -3, partial: true });
    await expect(session.prefillUserMultimodal('', [audio()], opts)).rejects.toMatchObject({ rc: -3, partial: true });
    expect(session.trunk).toBeNull();
    expect(ctx.cellsUsed).toBe(0);
    await expect(session.prefillUserMultimodal('', [audio()], opts)).rejects.toThrow('partial decode');
    expect(ctx._storeAvailable()).toBe(4);
    await session.dispose();
  });
});
