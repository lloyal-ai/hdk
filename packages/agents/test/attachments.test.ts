/**
 * The attachments store and the replay path that depends on it.
 *
 * A trace records the media marker, not the pixels, so replaying a
 * media-seeded spine means putting the original bytes back into the cache.
 * The failure that matters is not an exception — it is a replay that SUCCEEDS
 * having tokenized the marker as text, producing a different KV state behind
 * an identical-looking prompt. Every case below that ends in a throw is
 * guarding that one silent outcome.
 */
import { describe, it, expect } from 'vitest';
import { run, scoped, call, createScope } from 'effection';
import type { Operation } from 'effection';
import type { ContentIngress } from '@lloyal-labs/media';
import { mkdtempSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockSessionContext } from '../../sdk/src/testing.js';
import { BranchStore } from '../../sdk/src/BranchStore';
import { NullAttachmentStore } from '@lloyal-labs/media';
import type { AttachmentStore } from '@lloyal-labs/media';
import { MemoryAttachmentStore } from './helpers/memory-store';
import { representationsOf, sourceOf, ATTACHMENT_ARTIFACT_TYPE, EMPTY_DESCRIPTOR, MANIFEST_TYPE } from '@lloyal-labs/media';
import type { Attachment } from '@lloyal-labs/media';

/** A manifest descriptor, shaped the way a store would have returned one.
 *  `Attachment` is branded, so a test that fabricates a root says so here
 *  rather than in four places — and cannot pass a REPRESENTATION descriptor
 *  where a root belongs, which is the confusion the marker guard once
 *  shipped. */
const attachmentRef = (digest: string, size = 9): Attachment =>
  ({ digest, mediaType: MANIFEST_TYPE, size }) as Attachment;
import { sniffMediaType } from '@lloyal-labs/media';
import { materialize } from '@lloyal-labs/media';
import { prepareBatch } from '../src/prepare-content';
import { initAgents } from '../src/init';
import { Branch } from '../../sdk/src/Branch';
import { CapturingTraceWriter } from './helpers/capturing-trace';
import { rawIngress } from './helpers/raw-ingress';
import { reconstructBranch, extractSpineSeed, replayTurns, replayAgentTurns, type AgentTurnRecord, type BranchCheckpoint } from '../src/replay';
import { Ctx, Store, Attachments } from '../src/context';
import type { TraceEvent } from '../src/trace-types';

const MARKER = '<__media__>';
const tmp = (): string => mkdtempSync(join(tmpdir(), 'lloyal-att-'));

// Real magic bytes — the sniffer reads these, so a fake header would test
// nothing about the format table.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const BMP = new Uint8Array([0x42, 0x4d, 7, 7]);
const JUNK = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

/** Store bytes as a one-representation attachment — the shape a
 *  non-normalizing ingress produces. */
const attach = (store: AttachmentStore, bytes: Uint8Array) =>
  store.putAttachment({ representations: [store.putBlob(bytes, sniffMediaType(bytes))!] });

/** How many attachment manifests a store actually committed. Reads the store
 *  through its own surface rather than its internals, so it says the same
 *  thing whatever backs it. */
function committedManifests(store: MemoryAttachmentStore): number {
  let n = 0;
  for (const digest of store.blobs.keys()) if (store.getManifest(digest)) n++;
  return n;
}

describe('extractSpineSeed', () => {
  const seedEvent = (traceId: number, parentTraceId: number | null, text: string) => ({
    traceId, parentTraceId, ts: 0, type: 'prompt:format' as const,
    promptText: text, tokenCount: 5, messages: '[]', role: 'spine' as const,
  });
  const headerEvent = (parentTraceId: number | null, digest: string) => ({
    traceId: 99, parentTraceId, ts: 0, type: 'branch:prefill' as const,
    branchHandle: 1, cells: 5, role: 'spineHeader' as const,
    attachments: [attachmentRef(digest)],
  });

  it('pairs the seed with the attachments emitted in its own scope', () => {
    const events: TraceEvent[] = [seedEvent(1, 7, `hi ${MARKER}`), headerEvent(7, 'd1')];
    expect(extractSpineSeed(events).seedAttachments).toEqual([attachmentRef('d1')]);
  });

  it('does not claim another pool spine’s images', () => {
    // Two spines in one trace: the outer seed must not adopt the nested
    // pool's attachments just because they appear in the same file.
    const events: TraceEvent[] = [seedEvent(1, 7, 'text only'), headerEvent(42, 'other')];
    expect(extractSpineSeed(events).seedAttachments).toBeUndefined();
  });

  it('falls back to the seed’s write-ahead roots when the prefill never landed', () => {
    // A spine whose multimodal prefill FAILED has a seed but no
    // `branch:prefill` — and that failure is exactly when replay is the only
    // way back. The barrier committed the content before the prefill, so the
    // write-ahead roots are real.
    const events: TraceEvent[] = [
      { ...seedEvent(1, 7, `hi ${MARKER}`), attachments: [attachmentRef('d9')] },
    ];
    expect(extractSpineSeed(events).seedAttachments).toEqual([attachmentRef('d9')]);
  });

  it('prefers the success-only copy over the write-ahead one', () => {
    const events: TraceEvent[] = [
      { ...seedEvent(1, 7, `hi ${MARKER}`), attachments: [attachmentRef('ahead')] },
      headerEvent(7, 'landed'),
    ];
    expect(extractSpineSeed(events).seedAttachments).toEqual([attachmentRef('landed')]);
  });
});

describe('reconstructBranch', () => {
  // Typed as the CONTRACT, not the null object: the default is a
  // NullAttachmentStore but callers pass a MemoryAttachmentStore, and
  // inferring the parameter from the default would reject every one of them.
  const withCtx = (
    fn: (ctx: MockSessionContext) => unknown,
    store: AttachmentStore = new NullAttachmentStore(),
  ) =>
    run(function*() {
      const ctx = new MockSessionContext();
      return yield* scoped(function*() {
        yield* Ctx.set(ctx as never);
        yield* Store.set(new BranchStore(ctx as never));
        yield* Attachments.set(store);
        return yield* (fn as (c: MockSessionContext) => Operation<unknown>)(ctx);
      });
    });

  const cp = (over: Partial<BranchCheckpoint> = {}): BranchCheckpoint =>
    ({ seedPrompt: 'plain seed', turns: [], ...over });

  it('replays a text-only spine unchanged', async () => {
    const branch = await withCtx(function*() {
      return yield* reconstructBranch(cp());
    });
    expect(branch).toBeDefined();
  });

  it('replayTurns is provenance-blind — deltas land on a fork of live state', async () => {
    // The primitive's contract: it applies turns to WHATEVER branch it is
    // given — a fresh seed rebuild or a fork of a resident spine — without
    // guards about the prefix. The fork case is the one reconstructBranch
    // itself never exercises.
    await withCtx(function*(ctx) {
      const spine = yield* reconstructBranch(cp());
      const fork = spine.forkSync();
      let prefills = 0;
      const orig = ctx._storePrefill.bind(ctx);
      ctx._storePrefill = async (h, t) => { prefills++; return orig(h, t); };
      yield* replayTurns(fork, [
        { userContent: 'u1', assistantContent: 'a1' },
        { userContent: 'u2', assistantContent: 'a2' },
      ]);
      expect(prefills).toBe(2);
      return null;
    });
  });

  it('replayAgentTurns replays an agent-shaped record — assistant, tool result, probe, media', async () => {
    // The agent's KV timeline is not user/assistant pairs: assistant turns,
    // tool-result deltas and probe prefills, with a media-bearing result
    // resolving through the store exactly as a seed does.
    const store = new MemoryAttachmentStore();
    const root = attach(store, PNG);
    await withCtx(function*(ctx) {
      const spine = yield* reconstructBranch(cp());
      const fork = spine.forkSync();
      let tokenPrefills = 0;
      const orig = ctx._storePrefill.bind(ctx);
      ctx._storePrefill = async (h, t) => { tokenPrefills++; return orig(h, t); };

      const records: AgentTurnRecord[] = [
        { kind: 'assistant', text: 'looking at the chart <tool_call>rasterize</tool_call>' },
        { kind: 'toolResult', resultStr: '{"page":"p1"}', callId: 'c1' },
        { kind: 'probe', text: 'what stands out?' },
        { kind: 'toolResult', resultStr: '{"page":"p2"}', callId: 'c2', attachments: [root] },
      ];
      yield* replayAgentTurns(fork, records, { enableThinking: false });

      // Three token deltas (assistant, tool result, probe)…
      expect(tokenPrefills).toBe(3);
      // …and the media record went down the embedding rail with the stored bytes.
      expect(ctx.multimodalPrefills).toHaveLength(1);
      expect(ctx.multimodalPrefills[0].bitmapCounts).toEqual([1]);
      return null;
    }, store);
  });

  it('refuses a marker with no attachment references', async () => {
    // The pre-attachments behaviour, preserved: a trace that recorded only
    // the marker still cannot be replayed.
    await expect(withCtx(function*() {
      return yield* reconstructBranch(cp({ seedPrompt: `look ${MARKER}` }));
    })).rejects.toThrow(/carries no attachment references/);
  });

  it('refuses when the context has no projector', async () => {
    const dir = tmp();
    const store = new MemoryAttachmentStore();
    const ref = attach(store, PNG);
    await expect(run(function*() {
      const ctx = new MockSessionContext();
      ctx.mockSupportsVision = false;
      return yield* scoped(function*() {
        yield* Ctx.set(ctx as never);
        yield* Store.set(new BranchStore(ctx as never));
        yield* Attachments.set(store);
        return yield* reconstructBranch(cp({
          seedPrompt: `look ${MARKER}`, seedAttachments: [ref],
        }));
      });
    })).rejects.toThrow(/no vision projector/);
  });

  it('refuses when the bytes are gone from the store', async () => {
    // The attachments directory moved or was pruned. Replaying the marker as
    // text here would look like success and be a different KV state.
    await expect(withCtx(function*() {
      return yield* reconstructBranch(cp({
        seedPrompt: `look ${MARKER}`,
        seedAttachments: [attachmentRef('sha256:' + 'e'.repeat(64))],
      }));
    }, new MemoryAttachmentStore())).rejects.toThrow(/not in the content store/);
  });

  it('replays N markers from ONE multi-representation attachment', async () => {
    // The case the old guard rejected: it compared marker count against
    // ATTACHMENT count, so a single manifest holding two sampled frames threw
    // before resolution ran. One manifest is one image, one video, or one live
    // capture — the count that must match is REPRESENTATIONS.
    const store = new MemoryAttachmentStore();
    const video = store.putAttachment({
      representations: [
        store.putBlob(PNG, 'image/png', { 'ai.lloyal.derive.frame': '0' })!,
        store.putBlob(JPEG, 'image/jpeg', { 'ai.lloyal.derive.frame': '1' })!,
      ],
      source: store.putBlob(GIF, 'video/mp4')!,
    });
    const image = attach(store, BMP);

    const seen = await withCtx(function*(ctx: MockSessionContext) {
      // Three markers, TWO attachment descriptors.
      yield* reconstructBranch(cp({
        seedPrompt: `${MARKER} ${MARKER} and ${MARKER}`,
        seedAttachments: [video, image],
      }));
      return ctx;
    }, store) as MockSessionContext;

    expect(seen.multimodalPrefills[0].bitmapCounts).toEqual([3]);
  });

  it('refuses when representations and markers disagree', async () => {
    const store = new MemoryAttachmentStore();
    const two = store.putAttachment({
      representations: [
        store.putBlob(PNG, 'image/png')!,
        store.putBlob(JPEG, 'image/jpeg')!,
      ],
    });
    // One marker, one attachment — but it expands to two representations, so
    // rebuilding would put two images where the prompt marks one.
    await expect(withCtx(function*() {
      return yield* reconstructBranch(cp({
        seedPrompt: `look ${MARKER}`, seedAttachments: [two],
      }));
    }, store)).rejects.toThrow(/expand to 2 representation/);
  });

  it('replays a media-seeded spine down the embedding rail', async () => {
    const store = new MemoryAttachmentStore();
    const ref = attach(store, PNG);
    const seen = await withCtx(function*(ctx: MockSessionContext) {
      yield* reconstructBranch(cp({
        seedPrompt: `look ${MARKER}`, seedAttachments: [ref],
      }));
      return ctx;
    }, store) as MockSessionContext;
    // The proof is the rail, not the absence of a throw: a marker tokenized
    // as text would go down the token path and never reach this array. Byte
    // fidelity is the store round-trip's job, above.
    expect(seen.multimodalPrefills).toHaveLength(1);
    expect(seen.multimodalPrefills[0].bitmapCounts).toEqual([1]);
    expect(seen.multimodalPrefills[0].prompts[0]).toContain(MARKER);
  });
});

describe('the trunk ingress (warmDelta)', () => {
  const runTurn = (images: Uint8Array[]) =>
    run(function*() {
      const ctx = new MockSessionContext();
      const tw = new CapturingTraceWriter();
      const store = new MemoryAttachmentStore();
      return yield* scoped(function*() {
        const { session } = yield* initAgents(ctx as never, {
          traceWriter: tw,
          attachmentStore: store,
        });
        session.trunk = Branch.create(ctx as never, 0, {});
        if (images.length > 0) {
          // The real caller's order: BARRIER first, then prefill the admitted
          // representations, then the observer records roots that are already
          // committed. Nothing is stored after the prefill any more.
          const prepared = yield* call(() => prepareBatch(
            rawIngress(store), store,
            images,
          ));
          yield* call(() => session.prefillUserMultimodal(
            'what is this?',
            prepared.bitmaps as Uint8Array[],
            { attachments: prepared.attachments },
          ));
        } else {
          yield* call(() => session.prefillUser('what is this?'));
        }
        return tw.events.filter(
          (e): e is Extract<TraceEvent, { type: 'branch:prefill' }> =>
            e.type === 'branch:prefill' && e.role === 'warmDelta',
        );
      });
    });

  it('records the images a user attached to their turn', async () => {
    const events = await runTurn([PNG, JPEG]);
    expect(events).toHaveLength(1);
    // This ingress records the RAW turn text, not the rendered prompt, so
    // `content` carries no marker — the references are the only thing in the
    // trace that says this turn had images at all. That is what makes them
    // load-bearing here rather than decorative.
    expect(events[0].content).toBe('what is this?');
    expect(events[0].content).not.toContain(MARKER);
    expect(events[0].attachments).toHaveLength(2);
    // Each reference is a MANIFEST — the per-image media types live on its
    // layers, which is what makes video (one manifest, N frames) additive.
    expect(events[0].attachments!.map(a => a.mediaType))
      .toEqual(Array(2).fill(MANIFEST_TYPE));
  });

  it('projects trunk media ONCE, however many agents fork from it', async () => {
    // The differentiator, asserted rather than assumed: the image is prefilled
    // onto the trunk once, and every fork inherits those cells. N agents cost
    // one projection, not N.
    const ctx = new MockSessionContext();
    const store = new MemoryAttachmentStore();
    await run(function*() {
      return yield* scoped(function*() {
        yield* Ctx.set(ctx as never);
        yield* Store.set(new BranchStore(ctx as never));
        yield* Attachments.set(store);
        const { session } = yield* initAgents(ctx as never, { attachmentStore: store });
        session.trunk = Branch.create(ctx as never, 0, {});
        const prepared = yield* call(() => prepareBatch(
          rawIngress(store), store, [PNG],
        ));
        yield* call(() => session.prefillUserMultimodal('what is this?',
          prepared.bitmaps as Uint8Array[], { attachments: prepared.attachments }));
        // Fork several branches off the trunk, as a pool would, then prune
        // them the way a pool does on return — the trunk cannot dispose with
        // live children.
        const forks = Array.from({ length: 4 }, () => session.trunk!.forkSync());
        for (const f of forks) f.pruneSync();
        return null;
      });
    });
    expect(ctx.multimodalPrefills).toHaveLength(1);
    expect(ctx.multimodalPrefills[0].bitmapCounts).toEqual([1]);
  });

  it('leaves the field absent on a text-only turn', async () => {
    const events = await runTurn([]);
    expect(events).toHaveLength(1);
    // The distinction being guarded is `[]` vs nothing: an empty array reads
    // downstream as a media turn whose images all failed to store, which is a
    // different claim from a text turn. (`undefined` vs an absent key is not
    // guarded here and needs no guard — JSON.stringify drops both, and the
    // trace is JSONL.)
    expect(events[0].attachments).toBeUndefined();
  });
});

describe('prepareBatch — the barrier before any prefill', () => {
  it('a halted scope ABORTS the ingress it was waiting on', async () => {
    // The conformance property for this whole boundary. `call()` makes a halt
    // OBSERVABLE here, but it cannot stop the promise behind it — the leaked
    // effect Effection's own docs warn about — so what actually reaches the
    // non-Effection side is the signal. Without it a cancelled run keeps
    // occupying the normalizer's queue with work nobody will read.
    //
    // `AbortSignal` is the currency precisely because it is NOT framework
    // shaped: `@lloyal-labs/media` carries no Effection dependency, and the
    // HTTP ingress route calls the same function from a plain Node handler.
    const store = new MemoryAttachmentStore();
    let sawAbort = false;
    let entered!: () => void;
    const reachedIngress = new Promise<void>((r) => { entered = r; });

    const hanging: ContentIngress = {
      ingest: (_bytes, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          sawAbort = true;
          reject(new Error('aborted'));
        });
        entered();
      }),
    };

    const [scope, destroy] = createScope();
    // A halted task rejects; nothing here is asserting on its outcome.
    scope.run(function*() { return yield* prepareBatch(hanging, store, [PNG]); })
      .catch(() => { /* halted */ });

    await reachedIngress;
    await destroy();

    expect(sawAbort, 'the ingress never saw the scope go away').toBe(true);
  });

  /** An ingress that admits the first `failAt` items and then refuses. */
  const flaky = (store: AttachmentStore, failAt: number) => {
    let n = 0;
    return {
      ingest: async (bytes: Uint8Array) => {
        if (n++ === failAt) throw new Error('ingest refused item ' + failAt);
        const rep = store.putBlob(bytes, sniffMediaType(bytes));
        return store.putAttachment({ representations: [rep] });
      },
    };
  };

  it('flattens by REPRESENTATION, preserving order across attachments', async () => {
    // Markers correspond to representations, not roots: a video contributes
    // its frames, an image contributes one.
    const store = new MemoryAttachmentStore();
    const video = store.putAttachment({
      representations: [store.putBlob(PNG, 'image/png')!, store.putBlob(JPEG, 'image/jpeg')!],
      source: store.putBlob(GIF, 'video/mp4')!,
    });
    const image = store.putAttachment({ representations: [store.putBlob(BMP, 'image/bmp')!] });

    const prepared = materialize(store, [video, image]);
    expect(prepared.attachments).toHaveLength(2);
    expect(prepared.bitmaps).toHaveLength(3);
    // Attachment order outer, representation order inner — and never the
    // source, which the model did not see.
    expect(prepared.bitmaps.map(b => Array.from(b.slice(0, 2))))
      .toEqual([[0x89, 0x50], [0xff, 0xd8], [0x42, 0x4d]]);
  });

  it('admits the whole batch or none of it', async () => {
    const store = new MemoryAttachmentStore();
    const items = [PNG, JPEG, BMP];
    const ok = await run(function*() { return yield* prepareBatch(flaky(store, -1), store, items); });
    expect(ok.bitmaps).toHaveLength(3);
    expect(ok.attachments).toHaveLength(3);
  });

  it('a failure on item N publishes NOTHING, though 1..N-1 may orphan', async () => {
    const store = new MemoryAttachmentStore();
    const items = [PNG, JPEG, BMP];
    await expect(run(function*() {
      return yield* prepareBatch(flaky(store, 2), store, items);
    })).rejects.toThrow(/refused item 2/);

    // Items 0 and 1 committed before the failure. That is HARMLESS —
    // content-addressed, referenced by nothing — and is the orphan class the
    // write-order invariant already accepts. What matters is that the caller
    // got nothing back, so it cannot have emitted a marker or prefilled.
    expect(committedManifests(store)).toBe(2);
  });

  it('refuses the batch when no content store is installed', async () => {
    // The gate that makes addressability a precondition rather than a
    // best-effort record: a media-bearing run with no store fails HERE, before
    // any KV is touched.
    const store = new NullAttachmentStore();
    await expect(run(function*() {
      return yield* prepareBatch(
        { ingest: () => Promise.reject(new Error('unused')) }, store, [],
      );
    })).resolves.toEqual({ attachments: [], bitmaps: [] }); // text-only: unaffected
  });

  it('keeps the index writer serialized by staying SYNCHRONOUS', () => {
    // One shared store instance only guarantees a single serialized index
    // writer while the read-modify-write has no yield point. Making these
    // async would silently reintroduce the interleaving — so the property is
    // asserted, not assumed.
    const store = new MemoryAttachmentStore();
    const d = store.putBlob(PNG, 'image/png');
    expect(d).not.toBeInstanceOf(Promise);
    expect(store.putAttachment({ representations: [d!] })).not.toBeInstanceOf(Promise);
    expect(store.get(d!.digest)).not.toBeInstanceOf(Promise);
  });
});
