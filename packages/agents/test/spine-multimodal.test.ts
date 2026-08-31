/**
 * `withSpine({ bitmaps })` — the spine ingress.
 *
 * The shipped feature had no coverage at all, so nothing caught that a
 * refactor of the marker construction changed the rendered header. These lock
 * the three things that would break silently: the images take the embedding
 * rail rather than the token rail, one marker is emitted per image, and the
 * branch's position advances by LESS than the cells consumed (the M-RoPE
 * decoupling) because the count comes from the native return rather than from
 * JS tokenization.
 */
import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import { MockSessionContext } from '../../sdk/test/MockSessionContext';
import { BranchStore } from '../../sdk/src/BranchStore';
import { withSpine } from '../src/spine';
import { extractSpineSeed } from '../src/replay';
import { Ctx, Store, Trace, Attachments, Ingress } from '../src/context';
import { MemoryAttachmentStore } from './helpers/memory-store';
import { rawIngress } from './helpers/raw-ingress';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapturingTraceWriter } from './helpers/capturing-trace';

const SYSTEM = 'You are a research assistant.';
const img = (n: number): Uint8Array[] =>
  Array.from({ length: n }, (_, i) => new Uint8Array([i, i + 1, i + 2]));

const markerCount = (s: string): number => (s.match(/<__media__>/g) ?? []).length;

/** The spine body both runners drive — identical wiring, so a failing run
 *  differs from a passing one only in what the context does. */
function spineBody(
  ctx: MockSessionContext,
  trace: CapturingTraceWriter,
  bitmaps: Uint8Array[] | undefined,
) {
  const store = new BranchStore(ctx);
  return function* () {
    yield* Ctx.set(ctx as never);
    yield* Store.set(store as never);
    yield* Trace.set(trace);
    // A real store: media paths now REFUSE to run without one, because
    // unaddressed media makes a run unreplayable. Tests that exercise them
    // must be configured the way a real harness is.
    const contentStore = new MemoryAttachmentStore();
    yield* Attachments.set(contentStore);
    // Media now refuses to run without an ingress, because unnormalized,
    // unaddressed bytes make a run unreplayable. Tests use a raw one — they
    // exercise the rail, not the normalizer.
    yield* Ingress.set(rawIngress(contentStore));

    return yield* withSpine(
      { systemPrompt: SYSTEM, ...(bitmaps ? { bitmaps } : {}) },
      function* (spine) {
        return { position: spine.position, cellsUsed: ctx.cellsUsed };
      },
    );
  };
}

async function runSpine(bitmaps: Uint8Array[] | undefined) {
  const ctx = new MockSessionContext({ nCtx: 16384, cellsUsed: 0 });
  const trace = new CapturingTraceWriter();

  // Captured INSIDE the body: withSpine registers an ensure() that prunes the
  // spine on scope exit, and pruning decrements cellsUsed. Reading either after
  // run() returns measures a torn-down spine.
  const live = await run(spineBody(ctx, trace, bitmaps));

  return { ctx, trace, ...live };
}

/** Drive a spine whose native multimodal prefill reports a failure, and keep
 *  the trace — which is the whole point: what a FAILED prefill leaves behind
 *  is what decides whether the run can be replayed. */
async function runFailingSpine(bitmaps: Uint8Array[], why: string) {
  const ctx = new MockSessionContext({ nCtx: 16384, cellsUsed: 0 });
  ctx.mockMultimodalError = () => why;
  const trace = new CapturingTraceWriter();

  const error = await run(spineBody(ctx, trace, bitmaps)).then(
    () => null,
    (e: unknown) => e as Error,
  );

  return { ctx, trace, error };
}

describe('withSpine({ bitmaps })', () => {
  it('routes images down the embedding rail, not the token rail', async () => {
    const { ctx } = await runSpine(img(1));

    expect(ctx.multimodalPrefills).toHaveLength(1);
    expect(ctx.multimodalPrefills[0].bitmapCounts).toEqual([1]);
  });

  it('takes the token rail when there are no bitmaps', async () => {
    const { ctx } = await runSpine(undefined);
    expect(ctx.multimodalPrefills).toHaveLength(0);
  });

  it('emits one marker per image into the system header', async () => {
    const { ctx } = await runSpine(img(3));

    const prompt = ctx.multimodalPrefills[0].prompts[0];
    expect(markerCount(prompt)).toBe(3);
    expect(prompt).toContain(SYSTEM);
  });

  it('advances position by less than the cells consumed', async () => {
    // The whole point of the embedding rail: an image occupies more KV cells
    // than it advances position. If the spine ever went back to using a
    // JS-tokenized count these would be equal and the gauge would drift.
    const n = 2;
    const { ctx, position, cellsUsed } = await runSpine(img(n));

    const slackPerImage = ctx.mockImageCells - ctx.mockImagePositions;
    expect(cellsUsed - position).toBe(n * slackPerImage);
    expect(position).toBeLessThan(cellsUsed);
  });

  it('reports the header cell count from the native return, in the trace', async () => {
    const { ctx, trace } = await runSpine(img(1));

    const seed = trace.ofType('prompt:format').find((e) => e.role === 'spine');
    expect(seed, 'expected prompt:format with role=spine').toBeDefined();
    expect(markerCount(seed!.promptText)).toBe(1);

    const header = trace.ofType('branch:prefill').find((e) => e.role === 'spineHeader');
    expect(header, 'expected branch:prefill with role=spineHeader').toBeDefined();
    // The count must come from the native return, not be re-derived in JS.
    expect(header!.cells).toBe(ctx.multimodalPrefills[0].results[0].tokensDecoded);
  });

  describe('when the native prefill fails', () => {
    const WHY = 'clip encode failed on image 0';

    it('fails the spine rather than continuing on an unprefilled branch', async () => {
      const { error } = await runFailingSpine(img(1), WHY);
      expect(error?.message ?? '').toContain(WHY);
    });

    it('still leaves a replayable seed in the trace', async () => {
      // `prompt:format` is write-ahead INTENT — the prompt a replay rebuilds
      // from. Emitting it only after a successful prefill means the one run
      // that most needs reconstructing is the one that cannot be.
      const { trace } = await runFailingSpine(img(1), WHY);
      expect(() => extractSpineSeed(trace.events)).not.toThrow();
    });

    it('claims no KV movement', async () => {
      // `branch:prefill` asserts the cache CHANGED. After a poisoned prefill
      // nothing landed, so a reader must not find one.
      const { trace } = await runFailingSpine(img(1), WHY);
      const header = trace.ofType('branch:prefill').find((e) => e.role === 'spineHeader');
      expect(header).toBeUndefined();
    });
  });
});
