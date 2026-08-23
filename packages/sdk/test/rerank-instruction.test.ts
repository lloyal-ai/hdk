/**
 * The instruction is a PARAMETER — prove it reaches the model and the gate.
 *
 * Without this, a custom `RerankInstruction` could be accepted and silently
 * dropped, or wired to the default, and CI would stay green. That is not
 * hypothetical: the same class of failure — an option a build silently ignored —
 * produced a full run of calibration numbers for the wrong instruction while
 * every check passed.
 *
 * The evals under `packages/rig/test/evals/reranker/` measure whether an
 * instruction is any GOOD. They need a 640 MB model and print for a human.
 * These tests answer the narrower question CI can actually hold: is the
 * instruction USED?
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import { Rerank, RerankCalibrationError, RETRIEVAL_INSTRUCTION } from '@lloyal-labs/sdk';
import type { SessionContext, RerankInstruction } from '@lloyal-labs/sdk';
import { MockSessionContext } from './MockSessionContext';

const CUSTOM: RerankInstruction = {
  text: 'Judge whether the statement is entailed by the evidence',
  smokeTest: {
    query: 'the assessor attended on 12 March',
    matching: 'the assessor attended the property on 12 March',
    nonMatching: 'photosynthesis converts carbon dioxide into glucose',
    // The mock's default logits give a gap of 4.0, so this passes.
    minGap: 1.0,
  },
};

const mock = (): MockSessionContext => new MockSessionContext();

describe('RerankOpts.instruction', () => {
  it('renders the custom <Instruct> line into the prompt', async () => {
    const ctx = mock();
    await Rerank.create(ctx as unknown as SessionContext, { instruction: CUSTOM });

    const prompts = ctx.formatChatCalls.join('\n');
    expect(prompts).toContain(`<Instruct>: ${CUSTOM.text}`);
    // And NOT the default — the assertion that catches "accepted then ignored".
    expect(prompts).not.toContain(RETRIEVAL_INSTRUCTION.text);
  });

  it('defaults to retrieval when none is given', async () => {
    const ctx = mock();
    await Rerank.create(ctx as unknown as SessionContext, {});
    expect(ctx.formatChatCalls.join('\n')).toContain(
      `<Instruct>: ${RETRIEVAL_INSTRUCTION.text}`,
    );
  });

  it("uses the instruction's OWN smokeTest fixtures, not the default pair", async () => {
    const ctx = mock();
    await Rerank.create(ctx as unknown as SessionContext, { instruction: CUSTOM });
    const prompts = ctx.formatChatCalls.join('\n');
    expect(prompts).toContain(CUSTOM.smokeTest.matching);
    expect(prompts).not.toContain(RETRIEVAL_INSTRUCTION.smokeTest.matching);
  });

  it('enforces the instruction\'s OWN minGap', async () => {
    // The mock yields a gap of 4.0. A minGap above it must reject — proving the
    // number came from the instruction and not from the old hardcoded 1.0.
    const ctx = mock();
    await expect(
      Rerank.create(ctx as unknown as SessionContext, {
        instruction: { ...CUSTOM, smokeTest: { ...CUSTOM.smokeTest, minGap: 99 } },
      }),
    ).rejects.toThrow(RerankCalibrationError);
  });

  it('names the instruction and its gap in the failure, not a generic message', async () => {
    const ctx = mock();
    let msg = '';
    try {
      await Rerank.create(ctx as unknown as SessionContext, {
        instruction: { ...CUSTOM, smokeTest: { ...CUSTOM.smokeTest, minGap: 99 } },
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    // A gate that fails without naming the question it was gating is unactionable.
    expect(msg).toContain(CUSTOM.text);
    expect(msg).toContain('99');
  });

  it('the DEFAULT path still gates at 1.0 — production behaviour, unchanged', async () => {
    // The union refactor must not loosen the shipped gate. A gap below 1.0 on
    // the default instruction must still refuse to boot, exactly as it did when
    // `1.0` was a literal in `create()`.
    const ctx = mock();
    ctx.logitsSequence = [[0.5, 0.0], [0.0, 0.0]]; // gap 0.5 — below the shipped minGap
    await expect(
      Rerank.create(ctx as unknown as SessionContext, {}),
    ).rejects.toThrow(RerankCalibrationError);
  });

  it('the default still PASSES on a healthy gap', async () => {
    const ctx = mock(); // default logits give a gap of 4.0
    await expect(Rerank.create(ctx as unknown as SessionContext, {})).resolves.toBeDefined();
  });

  it("boots unchecked on smokeTest: 'none' — the calibration-harness case", async () => {
    // A harness measuring an instruction it EXPECTS to invert cannot boot behind
    // a gate that rejects inversion. `-Infinity` used to be the only way to say
    // this, which required knowing the comparison is strict `>`.
    const ctx = mock();
    ctx.logitsSequence = [[0.0, 5.0], [0.0, 0.0]]; // matching scores BELOW non-matching
    const r = await Rerank.create(ctx as unknown as SessionContext, {
      instruction: { text: 'an instruction that inverts', smokeTest: 'none' },
    });
    expect(r).toBeDefined();
  });

  it("still renders the instruction when the smoke test is skipped", async () => {
    const ctx = mock();
    await Rerank.create(ctx as unknown as SessionContext, {
      instruction: { text: 'a skipped question', smokeTest: 'none' },
    });
    expect(ctx.formatChatCalls.join('\n')).toContain('<Instruct>: a skipped question');
  });

  it('releases the decode-owner mark when the smoke test rejects', async () => {
    // Otherwise a failed calibration poisons the context for any retry.
    const ctx = mock();
    await Rerank.create(ctx as unknown as SessionContext, {
      instruction: { ...CUSTOM, smokeTest: { ...CUSTOM.smokeTest, minGap: 99 } },
    }).catch(() => undefined);
    expect((ctx as unknown as { __decodeOwner?: string }).__decodeOwner).toBeUndefined();
  });
});
