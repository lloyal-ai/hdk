/**
 * The multimodal delta surface.
 *
 * These lock the two properties that distinguish it from the token path and
 * that nothing else asserts: markers are emitted structurally (one per image,
 * in order) rather than spliced, and the delta stops at the STRING stage
 * because mtmd owns tokenization downstream.
 */
import { describe, it, expect } from 'vitest';
import { MockSessionContext } from './MockSessionContext';
import {
  mediaContent,
  buildUserDeltaMultimodal,
  buildToolResultDeltaMultimodal,
  deltaCells,
  MEDIA_MARKER,
} from '../src/deltas';
import { Branch } from '../src/Branch';
import { Session } from '../src/Session';
import { BranchStore } from '../src/BranchStore';

const img = (n: number): Uint8Array[] =>
  Array.from({ length: n }, (_, i) => new Uint8Array([i, i + 1]));

const markerCount = (s: string): number => (s.match(/<__media__>/g) ?? []).length;

describe('mediaContent', () => {
  it('returns the bare string when there are no images', () => {
    // The text-path shape, so a caller can route both through one expression.
    expect(mediaContent('hello', [])).toBe('hello');
  });

  it('emits one marker part per image, after the text, in order', () => {
    const parts = mediaContent('describe these', img(3));
    expect(Array.isArray(parts)).toBe(true);
    expect(parts).toEqual([
      { type: 'text', text: 'describe these' },
      { type: 'media_marker', text: MEDIA_MARKER },
      { type: 'media_marker', text: MEDIA_MARKER },
      { type: 'media_marker', text: MEDIA_MARKER },
    ]);
  });

  it('emits structured parts, never a spliced string', () => {
    // Splicing would put the marker in the text part, where the part-joiner's
    // newline hygiene never sees it.
    const parts = mediaContent('x', img(1)) as Array<{ type: string; text: string }>;
    expect(parts[0].text).toBe('x');
    expect(parts[0].text).not.toContain(MEDIA_MARKER);
  });
});

describe('buildUserDeltaMultimodal', () => {
  it('carries the turn separator, one marker per image, and the bytes', () => {
    const ctx = new MockSessionContext();
    const images = img(2);
    const d = buildUserDeltaMultimodal(ctx, 'what is in these?', images);

    expect(d.sep).toEqual(ctx.getTurnSeparator());
    expect(markerCount(d.prompt)).toBe(2);
    expect(d.prompt).toContain('what is in these?');
    expect(d.bitmaps).toBe(images);
  });

  it('stops at the string stage — the prompt is not tokenized here', () => {
    // mtmd owns tokenization; tokenizing here would double-tokenize.
    const ctx = new MockSessionContext();
    const d = buildUserDeltaMultimodal(ctx, 'q', img(1));
    expect(typeof d.prompt).toBe('string');
  });
});

describe('buildToolResultDeltaMultimodal', () => {
  it('marks one image per bitmap and preserves the call id', () => {
    const ctx = new MockSessionContext();
    const d = buildToolResultDeltaMultimodal(ctx, '{"page":4}', 'call_7', img(1));

    expect(markerCount(d.prompt)).toBe(1);
    expect(d.prompt).toContain('call_7');
    expect(d.prompt).toContain('{\\"page\\":4}');
  });

  it('concatenates the generation prompt onto the STRING, not as tokens', () => {
    // The text builder appends tokenized generation-prompt ids. Here mtmd
    // tokenizes the whole prompt, so anything appended afterwards would never
    // reach it — the suffix has to be in the string.
    const ctx = new MockSessionContext();
    const orig = ctx.formatChatSync.bind(ctx);
    ctx.formatChatSync = (m: string, o?: never) => ({
      ...orig(m, o),
      generationPrompt: '<|im_start|>assistant\n',
    });

    const d = buildToolResultDeltaMultimodal(ctx, '{}', 'c1', img(1));
    expect(d.prompt.endsWith('<|im_start|>assistant\n')).toBe(true);
  });

  it('does not double-append a generation prompt already present', () => {
    const ctx = new MockSessionContext();
    const orig = ctx.formatChatSync.bind(ctx);
    ctx.formatChatSync = (m: string, o?: never) => {
      const r = orig(m, o);
      return { ...r, prompt: r.prompt + 'GEN', generationPrompt: 'GEN' };
    };

    const d = buildToolResultDeltaMultimodal(ctx, '{}', 'c1', img(1));
    expect(d.prompt.match(/GEN/g)?.length).toBe(1);
  });
});

describe('deltaCells — the quote must equal the charge', () => {
  it('quotes exactly what the prefill goes on to consume', async () => {
    const ctx = new MockSessionContext();
    const branch = Branch.create(ctx as never, 0, {});
    const delta = buildUserDeltaMultimodal(ctx as never, 'what is this?', img(2));

    const quote = await deltaCells(ctx as never, delta);
    const { tokensDecoded } = await branch.prefillMultimodal(
      delta.prompt, delta.bitmaps, delta.sep,
    );

    // Equality, not proximity: admission spends this number against headroom
    // before the prefill runs, so a low quote over-commits KV and a high one
    // wastes it. What this locks is the SDK wiring — that deltaCells hands the
    // cost query the SAME (sep, prompt, bitmaps) triple the prefill hands the
    // store. Dropping `sep`, or passing the caller's `images` instead of the
    // delta's `bitmaps`, diverges here.
    //
    // It does NOT prove the native count: that is MtmdSource::cells() reading
    // the tokenizer before any encode, verified separately on real weights
    // across 1-5 images — where image cost is non-linear (1 and 2 images both
    // cost 580 cells), which is why it is measured rather than estimated.
    expect(quote).toBe(tokensDecoded);
  });

  it('prices the sep tokens too, not just the prompt', async () => {
    const ctx = new MockSessionContext();
    const delta = buildUserDeltaMultimodal(ctx as never, 'hi', img(1));
    expect(delta.sep.length).toBeGreaterThan(0);
    const withSep = await deltaCells(ctx as never, delta);
    const withoutSep = await deltaCells(ctx as never, { ...delta, sep: [] });
    expect(withSep - withoutSep).toBe(delta.sep.length);
  });
});

describe('prefillUserMultimodal — cold bootstrap', () => {
  const session = (ctx: MockSessionContext) =>
    new Session({ ctx: ctx as never, store: new BranchStore(ctx as never) });

  it('creates and promotes a trunk when there is none', async () => {
    // The composer case: an image on the FIRST question, before any run has
    // established a trunk. Without this the call threw on `this._trunk!`.
    const ctx = new MockSessionContext();
    const s = session(ctx);
    expect(s.trunk).toBeNull();

    await s.prefillUserMultimodal('what is this?', img(1));

    expect(s.trunk).not.toBeNull();
    expect(ctx.multimodalPrefills).toHaveLength(1);
    // No separator on a fresh branch — there is no prior turn to separate
    // from, matching commitTurn's cold path.
    expect(ctx.multimodalPrefills[0].sepTokens[0]).toEqual([]);
  });

  it('appends to an existing trunk WITH the separator', async () => {
    const ctx = new MockSessionContext();
    const s = session(ctx);
    s.trunk = Branch.create(ctx as never, 0, {});

    await s.prefillUserMultimodal('and this?', img(1));

    expect(ctx.multimodalPrefills).toHaveLength(1);
    // The warm path must separate the turn, or it runs into the previous one.
    expect(ctx.multimodalPrefills[0].sepTokens[0].length).toBeGreaterThan(0);
  });

  it('puts the image on the TRUNK, so forks share its rows', async () => {
    // The property the cold path exists for: agents fork from the trunk, so
    // an image landed here is encoded once and attended by all of them.
    const ctx = new MockSessionContext();
    const s = session(ctx);
    await s.prefillUserMultimodal('what is this?', img(1));
    expect(ctx.multimodalPrefills[0].handles[0]).toBe(s.trunk!.handle);
  });
});

describe('marker defang — a literal marker in text never desynchronizes', () => {
  // The native layer splits the rendered prompt on EVERY literal
  // `<__media__>`, so text containing the marker would yield more markers
  // than bitmaps and fail (or mispair) the prefill.
  const HOSTILE = `look at ${MEDIA_MARKER} this`;

  it('mediaContent defangs the text part', () => {
    const parts = mediaContent(HOSTILE, img(2));
    expect(Array.isArray(parts)).toBe(true);
    const text = (parts as Array<{ type: string; text: string }>)[0].text;
    expect(text).not.toContain(MEDIA_MARKER);
    expect(text).toContain('look at');
  });

  it('a user delta carries exactly one marker per image, whatever the text says', () => {
    const ctx = new MockSessionContext();
    const d = buildUserDeltaMultimodal(ctx, HOSTILE, img(1), { system: HOSTILE });
    expect((d.prompt.match(/<__media__>/g) ?? []).length).toBe(1);
  });

  it('zero images means ZERO markers — even from hostile text', () => {
    // This delta still lands via the multimodal prefill, whose splitter
    // sees the whole prompt: one stray literal would mean 1 marker ≠ 0 bitmaps.
    const ctx = new MockSessionContext();
    const d = buildUserDeltaMultimodal(ctx, HOSTILE, []);
    expect((d.prompt.match(/<__media__>/g) ?? []).length).toBe(0);
  });

  it('a tool-result delta defangs the result string', () => {
    const ctx = new MockSessionContext();
    const d = buildToolResultDeltaMultimodal(ctx, JSON.stringify({ page: HOSTILE }), 'c1', img(1));
    expect((d.prompt.match(/<__media__>/g) ?? []).length).toBe(1);
  });
});

describe('prefillUserMultimodal — a failed prefill never leaves a poisoned trunk', () => {
  const mkSession = (ctx: MockSessionContext) =>
    new Session({ ctx: ctx as never, store: new BranchStore(ctx as never) });

  it('warm: prunes and clears the trunk, then rethrows', async () => {
    const ctx = new MockSessionContext();
    const s = mkSession(ctx);
    await s.prefillUserMultimodal('first', img(1)); // establishes the trunk
    const trunkHandle = s.trunk!.handle;

    const pruned: number[] = [];
    const origPrune = ctx._branchPrune.bind(ctx);
    ctx._branchPrune = (h: number) => { pruned.push(h); origPrune(h); };
    ctx.mockMultimodalError = () => 'decode exploded';

    await expect(s.prefillUserMultimodal('second', img(1))).rejects.toThrow('decode exploded');
    // The branch is poisoned (decode_segments is not atomic); leaving it
    // installed would let the next turn resume invalid KV.
    expect(s.trunk).toBeNull();
    expect(pruned).toContain(trunkHandle);
  });

  it('cold: prunes the never-promoted branch, leaking no slot', async () => {
    const ctx = new MockSessionContext();
    const s = mkSession(ctx);
    const pruned: number[] = [];
    const origPrune = ctx._branchPrune.bind(ctx);
    ctx._branchPrune = (h: number) => { pruned.push(h); origPrune(h); };
    ctx.mockMultimodalError = () => 'decode exploded';

    await expect(s.prefillUserMultimodal('first', img(1))).rejects.toThrow('decode exploded');
    expect(s.trunk).toBeNull();
    expect(pruned).toContain(ctx.multimodalPrefills[0].handles[0]);
  });
});
