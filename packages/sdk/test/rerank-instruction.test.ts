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

/** Narrow away `'none'` so a fixture's fields are addressable. */
const smokeOf = (i: RerankInstruction) => {
  if (i.smokeTest === 'none') throw new Error('fixture expects a smoke test');
  return i.smokeTest;
};

/**
 * The marker literals, read back out of the probe the implementation actually
 * renders. Restating them as constants here would let these tests keep passing
 * against markers the source had since changed — the collision cases would then
 * be inserting text that collides with nothing.
 *
 * The probe's user turn is `<Instruct>: …\n\n<Query>: Q\n\n<Document>: D`.
 */
async function probeMarkers(): Promise<{ q: string; d: string }> {
  const ctx = mock();
  await Rerank.create(ctx as unknown as SessionContext, {});
  const msgs = JSON.parse(ctx.formatChatCalls[0]) as { content: string }[];
  const content = msgs[1].content;
  const qAt = content.indexOf('<Query>: ') + '<Query>: '.length;
  const dAt = content.indexOf('<Document>: ') + '<Document>: '.length;
  return {
    q: content.slice(qAt, content.indexOf('\n\n<Document>: ')),
    d: content.slice(dAt),
  };
}

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
    // Both channels: the chat template carries the probe and the gate-2 canary,
    // while the smoke scoring assembles tokens directly — `nonMatching` only
    // ever reaches the model through tokenize, never through formatChat.
    const reached = [...ctx.formatChatCalls, ...ctx.tokenizeCalls].join('\n');
    const custom = smokeOf(CUSTOM);
    const shipped = smokeOf(RETRIEVAL_INSTRUCTION);

    // All THREE fields, because asserting only `matching` would pass an
    // implementation that took the custom matching and the default query.
    expect(reached).toContain(custom.query);
    expect(reached).toContain(custom.matching);
    expect(reached).toContain(custom.nonMatching);

    expect(reached).not.toContain(shipped.query);
    expect(reached).not.toContain(shipped.matching);
    expect(reached).not.toContain(shipped.nonMatching);
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

  it('rejects non-finite scores instead of letting Infinity clear the bar', async () => {
    // A `>` comparison is not a finiteness check. An Infinity matching score
    // against a finite non-matching one gives gap = Infinity, which clears
    // EVERY threshold — so a model emitting broken logits would boot clean.
    const ctx = mock();
    ctx.logitsSequence = [[Infinity, 0.0], [0.0, 1.0]];
    await expect(
      Rerank.create(ctx as unknown as SessionContext, {}),
    ).rejects.toThrow(RerankCalibrationError);
  });

  it('rejects a NaN score', async () => {
    // Characterisation, not a new guard: NaN already fails closed because the
    // comparison is written `!(gap > minGap)` and NaN loses every comparison.
    // Pinned so a later rewrite to `gap <= minGap` cannot silently invert it.
    const ctx = mock();
    ctx.logitsSequence = [[NaN, 0.0], [0.0, 1.0]];
    await expect(
      Rerank.create(ctx as unknown as SessionContext, {}),
    ).rejects.toThrow(RerankCalibrationError);
  });

  it('refuses a non-finite minGap rather than treating it as a disable', async () => {
    // -Infinity admits any gap. Allowing it would create a second, silent way
    // to switch the gate off when `smokeTest: 'none'` is the documented one.
    const ctx = mock();
    let msg = '';
    try {
      await Rerank.create(ctx as unknown as SessionContext, {
        instruction: {
          ...CUSTOM,
          smokeTest: { ...CUSTOM.smokeTest, minGap: -Infinity },
        },
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('must be finite');
    // And it points at the supported way to boot ungated.
    expect(msg).toContain("smokeTest: 'none'");
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

  it('refuses a negative minGap — a smoke test must never accept inversion', async () => {
    // `matching` outscoring `nonMatching` is this field's stated contract. A
    // finite negative threshold silently admits the opposite.
    const ctx = mock();
    let msg = '';
    try {
      await Rerank.create(ctx as unknown as SessionContext, {
        instruction: { ...CUSTOM, smokeTest: { ...smokeOf(CUSTOM), minGap: -5 } },
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('finite and >= 0');
  });

  it('segments correctly when the instruction contains the query marker', async () => {
    // The marker is appended AFTER caller text, so the caller's occurrence is
    // first and the implementation's is last. Searching forwards would split
    // inside the instruction and put the query in the wrong position.
    const { q } = await probeMarkers();
    const text = `Judge support ${q} carefully`;
    const ctx = mock();
    await Rerank.create(ctx as unknown as SessionContext, {
      instruction: { ...CUSTOM, text },
    });
    const prefixSegment = ctx.tokenizeCalls.find((t) => t.includes('<Instruct>'));
    expect(prefixSegment).toBeDefined();
    // The WHOLE instruction survives in the prefix, embedded marker included.
    expect(prefixSegment).toContain(text);
    expect(prefixSegment).toContain('<Query>');
  });

  it('segments correctly when the instruction contains the document marker', async () => {
    // Forwards search put this occurrence before the query marker, tripping
    // the `qi >= di` guard and rejecting an instruction that is legitimate.
    const { d } = await probeMarkers();
    const text = `Judge support ${d} carefully`;
    const ctx = mock();
    await expect(
      Rerank.create(ctx as unknown as SessionContext, {
        instruction: { ...CUSTOM, text },
      }),
    ).resolves.toBeDefined();
  });

  it('refuses smoke fixtures the scorer would truncate', async () => {
    // scoreBatch slices documents to the per-leaf budget, so an oversized
    // fixture would gate on different text than the one declared.
    const ctx = mock();
    let msg = '';
    try {
      await Rerank.create(ctx as unknown as SessionContext, {
        instruction: {
          ...CUSTOM,
          smokeTest: { ...smokeOf(CUSTOM), matching: 'x'.repeat(200_000) },
        },
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('exceed the per-leaf document budget');
  });

  it('the shipped default is deep-frozen', () => {
    // It is process-wide and resolved as the default on every create(), so a
    // consumer mutating it would change every later boot in the process.
    expect(Object.isFrozen(RETRIEVAL_INSTRUCTION)).toBe(true);
    expect(Object.isFrozen(smokeOf(RETRIEVAL_INSTRUCTION))).toBe(true);
  });

  it('construction does not dispose the context', async () => {
    const ctx = mock();
    await Rerank.create(ctx as unknown as SessionContext, {});
    expect(ctx.disposeCount).toBe(0);
  });

  it('dispose() disposes the context exactly once, and is idempotent', async () => {
    // Rerank takes ownership of ctx, so it is the only thing that may dispose
    // it on a successful boot. A second call must not double-dispose.
    const ctx = mock();
    const r = await Rerank.create(ctx as unknown as SessionContext, {});
    r.dispose();
    expect(ctx.disposeCount).toBe(1);
    r.dispose();
    expect(ctx.disposeCount).toBe(1);
  });

  it('the default renders the exact prefix this replaced, separators included', async () => {
    // Verbatim `USER_PREFIX` as it stood before the instruction was a
    // parameter. Every existing caller's prompt depends on this string down to
    // the blank line, so it is pinned as a literal rather than rebuilt from
    // the instruction it is supposed to be checking.
    const PREVIOUS_USER_PREFIX =
      '<Instruct>: Given a web search query, retrieve relevant passages that answer the query\n\n' +
      '<Query>: ';

    const ctx = mock();
    await Rerank.create(ctx as unknown as SessionContext, {});
    const msgs = JSON.parse(ctx.formatChatCalls[0]) as { content: string }[];
    expect(msgs[1].content.startsWith(PREVIOUS_USER_PREFIX)).toBe(true);
  });

  it('the derived markers are well-formed, so the collision cases collide', async () => {
    const { q, d } = await probeMarkers();
    expect(q.length).toBeGreaterThan(0);
    expect(d.length).toBeGreaterThan(0);
    expect(q).not.toBe(d);
    expect(q).not.toMatch(/\s/);
    expect(d).not.toMatch(/\s/);
  });
});
