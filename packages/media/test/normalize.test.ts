/**
 * The normalizer — the one place `sharp` actually runs.
 *
 * This suite exists because it did not: the package shipped with no tests, so
 * every claim about format conversion, the pixel ceiling and orientation was
 * unverified, and three defects survived (see the plan). The failures that
 * matter here are silent ones — an image that reaches the projector rotated,
 * or metadata that survives when the user assumed it did not.
 */
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { normalizeImage, DEFAULT_MAX_PIXELS, MAX_CONCURRENT_NORMALIZATIONS, MAX_INPUT_PIXELS } from '../src/image';
import type { NormalizedImage } from '../src/image';
// Its own list of nine, sourced from stb_image — NOT derived from the sniff
// table, which knows four. Deriving it was a defect: the pass-through gate read
// as covering six formats and covered one.
import { PROJECTOR_FORMATS } from '../src/index';

const solid = (width: number, height: number, format: 'jpeg' | 'png' | 'webp' | 'tiff' = 'jpeg') =>
  sharp({ create: { width, height, channels: 3, background: '#0a7' } })[format]().toBuffer()
    .then((b) => new Uint8Array(b));

const meta = (b: Uint8Array) => sharp(Buffer.from(b)).metadata();

/** Assert a derivation happened. Stating the premise here beats asserting on
 *  dimensions downstream — if a case stops deriving, this fails with the
 *  reason instead of a confusing size mismatch three lines later. */
function derived(r: NormalizedImage): NormalizedImage {
  if (!r.derived) throw new Error('expected normalizeImage to derive, but it passed through');
  return r;
}

describe('normalizeImage', () => {
  it('passes conforming bytes through UNTOUCHED', async () => {
    // Byte identity is the contract: the caller compares `norm.bytes !== bytes`
    // to decide whether a source layer is worth retaining at all.
    const src = await solid(64, 64);
    const out = await normalizeImage(src, {});
    expect(out.bytes).toBe(src);
    expect(out.mime).toBe('image/jpeg');
    expect(out.originalByteLength).toBe(src.byteLength);
  });

  it('converts a format the projector cannot decode', async () => {
    // The real justification for the dependency: sharp READS webp/tiff/heif/
    // svg, none of which mtmd decodes. Without this the file fails inside the
    // decoder mid-run, on a branch already in flight.
    for (const format of ['webp', 'tiff'] as const) {
      const out = await normalizeImage(await solid(64, 64, format), {});
      expect(PROJECTOR_FORMATS).toContain(out.mime);
      expect(out.mime).toBe('image/jpeg');
    }
  });

  it('holds the pixel ceiling', async () => {
    const out = derived(await normalizeImage(await solid(800, 600), { maxPixels: 10_000 }));
    expect(out.width * out.height).toBeLessThanOrEqual(10_000);
    // Aspect preserved: sharp fits inside the box.
    expect(out.width / out.height).toBeCloseTo(800 / 600, 1);
  });

  it('defaults its ceiling to the projector’s own', async () => {
    expect(DEFAULT_MAX_PIXELS).toBe(2048 * 2048);
  });

  it('applies EXIF orientation to the PIXELS, and still honours the ceiling', async () => {
    // A phone writes Orientation=6 for a portrait shot: stored 400x200,
    // displayed 200x400. Re-encoding drops the tag, so if the pixels are not
    // rotated here the model sees it sideways with nothing left to say so.
    const base = await solid(400, 200);
    const tagged = new Uint8Array(
      await sharp(Buffer.from(base)).withMetadata({ orientation: 6 }).jpeg().toBuffer(),
    );
    expect((await meta(tagged)).orientation).toBe(6);

    const out = derived(await normalizeImage(tagged, { maxPixels: 10_000 }));
    // Rotated: the result is portrait, as a viewer would show it.
    expect(out.height).toBeGreaterThan(out.width);
    // And the ceiling is measured on what the projector will actually receive —
    // computing it from the STORED dimensions overshoots by the aspect ratio.
    expect(out.width * out.height).toBeLessThanOrEqual(10_000);
    expect((await meta(out.bytes)).orientation ?? 1).toBe(1);
  });

  it('refuses a BMP above the ABSOLUTE ceiling even when maxPixels is raised past it', async () => {
    // sharp guards its own path with limitInputPixels = MAX_INPUT_PIXELS; the
    // BMP hand-off has only the header to go on, and a caller-raised maxPixels
    // must not open a decompression-bomb door the sharp path keeps shut.
    const bmp = Buffer.alloc(54 + 48, 0xff);
    bmp.write('BM', 0);
    bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(20_000, 18); bmp.writeInt32LE(20_000, 22);  // 4e8 pixels
    bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
    await expect(normalizeImage(new Uint8Array(bmp), { maxPixels: MAX_INPUT_PIXELS * 10 }))
      .rejects.toThrow(/ceiling|exceeds/);
  });

  it('hands BMP to the model rather than refusing it', async () => {
    // sharp cannot READ bmp, but stb_image — which is what mtmd loads with —
    // can. Refusing here would cost the user their whole query for a file the
    // model reads fine. Safe because `MtmdSource`'s constructor decodes every
    // bitmap before tokenize and before any decode_segments, so an unreadable
    // file fails at the same phase either way, branch untouched.
    const bmp = Buffer.alloc(54 + 48, 0xff);
    bmp.write('BM', 0);
    bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(4, 18); bmp.writeInt32LE(4, 22);
    bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
    const src = new Uint8Array(bmp);

    const out = await normalizeImage(src, {});
    expect(out.bytes).toBe(src);          // handed over verbatim
    expect(out.derived).toBe(false);
    expect(out.mime).toBe('image/bmp');
    // Dimensions ARE claimed now — read from the header, not decoded. This
    // assertion was the opposite until the admission policy landed: an
    // unmeasured pass-through cannot honour a pixel ceiling, and this is the
    // one path where nothing can downscale after the fact.
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
  });

  it('still refuses bytes NO decoder in the stack can read', async () => {
    // The pass-through is for formats the PROJECTOR reads. Junk is still junk,
    // and failing at ingress beats failing in the projector.
    await expect(normalizeImage(new Uint8Array([1, 2, 3, 4]), {}))
      .rejects.toThrow(/unsupported image format|not a decodable image/);
  });

  it('records a derivation only when one happened', async () => {
    const conforming = await solid(64, 64);
    expect((await normalizeImage(conforming, {})).derived).toBe(false);
    expect((await normalizeImage(conforming, { maxPixels: 1_000 })).derived).toBe(true);
    expect((await normalizeImage(await solid(64, 64, 'webp'), {})).derived).toBe(true);
  });

  it('reports what it saved', async () => {
    const src = await solid(1200, 900);
    const out = await normalizeImage(src, { maxPixels: 10_000 });
    expect(out.originalByteLength).toBe(src.byteLength);
    expect(out.bytes.byteLength).toBeLessThan(out.originalByteLength);
  });
});

describe('the two format lists are different questions', () => {
  it('PROJECTOR_FORMATS states what the DECODER reads, not what we can sniff', () => {
    // Ground truth: mtmd loads via `stbi_load_from_memory` with no STBI_NO_*
    // defines, so the projector reads stb_image's full set. The sniff table
    // recognises four of them. Deriving one list from the other made them
    // provably equal — which is how a rescue path that names six formats
    // shipped able to rescue exactly one.
    expect(PROJECTOR_FORMATS).toEqual(expect.arrayContaining([
      'image/jpeg', 'image/png', 'image/gif', 'image/bmp',
      'image/x-tga', 'image/vnd.adobe.photoshop', 'image/vnd.radiance',
      'image/x-softimage-pic', 'image/x-portable-anymap',
    ]));
    // The sniffable set is a STRICT SUBSET. If this ever becomes an equality,
    // someone has re-derived one from the other and the braid is back.
    const sniffable = ['image/jpeg', 'image/png', 'image/gif', 'image/bmp'];
    expect(PROJECTOR_FORMATS.length).toBeGreaterThan(sniffable.length);
    for (const f of sniffable) expect(PROJECTOR_FORMATS).toContain(f);
  });

  it('hands over only what it can IDENTIFY — the rest are refused, not guessed', async () => {
    // BMP: projector-readable AND sniffable → handed over.
    const bmp = Buffer.alloc(54 + 48, 0xff);
    bmp.write('BM', 0);
    bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(4, 18); bmp.writeInt32LE(4, 22);
    bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
    const out = await normalizeImage(new Uint8Array(bmp), {});
    expect(out.derived).toBe(false);
    expect(out.mime).toBe('image/bmp');

    // A projector-readable format we have NO signature for (TGA has no magic
    // bytes worth the name) sniffs as octet-stream and is refused rather than
    // passed through blind. Honest: nothing measured it, so nothing may admit
    // it under a contract that promises a ceiling.
    const tgaish = new Uint8Array([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 4, 0, 24, 0]);
    await expect(normalizeImage(tgaish, {})).rejects.toThrow();
  });
});

describe('KNOWN DEFECT — pinned, not endorsed', () => {
  it('DEFECT: metadata retention depends on whether the image hit the ceiling', async () => {
    // Re-encoding strips EXIF/ICC (sharp's default); the pass-through path
    // returns the source bytes verbatim and keeps everything — GPS included.
    // So a user's photo metadata survives or not according to its pixel count,
    // which nobody would predict. The fix is a deliberate policy either way.
    const withExif = new Uint8Array(
      await sharp(Buffer.from(await solid(64, 64))).withMetadata({ orientation: 1 }).jpeg().toBuffer(),
    );
    const passed = await normalizeImage(withExif, {});
    expect(passed.bytes).toBe(withExif);
    expect((await meta(passed.bytes)).exif).toBeDefined();

    const reencoded = await normalizeImage(withExif, { maxPixels: 1_000 });
    expect((await meta(reencoded.bytes)).exif).toBeUndefined();
  });

  describe('the admission policy — what may pass through BYTE-IDENTICAL', () => {
    // Pass-through is permitted only when every one of these holds: the format
    // is projector-supported, the pixels are under the ceiling, the dimensions
    // are known, EXIF orientation is identity, and the colour interpretation is
    // safe. Anything else DERIVES and keeps the original as the source layer.
    //
    // The reason is one fact about the decoder, verified in the vendored tree:
    // `stb_image.h` contains zero EXIF/orientation matches and mtmd applies no
    // rotation around `stbi_load_from_memory` (its only `rotate` is RoPE math
    // in clip.cpp). It also ignores ICC entirely. So anything we pass through
    // untouched is interpreted RAW — and a tag we leave on is a tag nobody
    // downstream will ever read.

    it('derives an image whose EXIF orientation is not identity, even UNDER the ceiling', async () => {
      // THE case the previous orientation test could not cover: it forced the
      // resize path with `maxPixels: 10_000`, so a phone JPEG small enough to
      // pass through reached the model sideways and the suite stayed green.
      const base = await solid(200, 100);
      const tagged = new Uint8Array(
        await sharp(Buffer.from(base)).withMetadata({ orientation: 6 }).jpeg().toBuffer(),
      );
      expect((await meta(tagged)).orientation).toBe(6);
      // Comfortably under the default ceiling — nothing about SIZE forces this.
      expect(200 * 100).toBeLessThan(DEFAULT_MAX_PIXELS);

      const out = derived(await normalizeImage(tagged, {}));

      expect(out.height).toBeGreaterThan(out.width);
      expect((await meta(out.bytes)).orientation ?? 1).toBe(1);
    });

    it('passes an identity-orientation image through untouched', async () => {
      // The other half: the rule must not derive everything. A tag of 1 says
      // the stored pixels ARE the displayed pixels, so there is nothing to fix.
      const base = await solid(200, 100);
      const tagged = new Uint8Array(
        await sharp(Buffer.from(base)).withMetadata({ orientation: 1 }).jpeg().toBuffer(),
      );

      const out = await normalizeImage(tagged, {});

      expect(out.derived).toBe(false);
      expect(out.bytes).toBe(tagged);
    });

    it('derives a non-sRGB profile to sRGB, and passes an sRGB one through', async () => {
      // `meta.space` is 'srgb' for a Display P3 image too — libvips reports the
      // PIXEL encoding, not the interpretation — so the profile itself is the
      // only signal. Left alone, P3 pixels reach a decoder that assumes sRGB
      // and the colours are simply wrong.
      const base = await solid(200, 100);
      const p3 = new Uint8Array(
        await sharp(Buffer.from(base)).withIccProfile('p3').jpeg().toBuffer(),
      );
      const srgb = new Uint8Array(
        await sharp(Buffer.from(base)).withIccProfile('srgb').jpeg().toBuffer(),
      );

      expect((await normalizeImage(p3, {})).derived).toBe(true);
      expect((await normalizeImage(srgb, {})).derived).toBe(false);
    });

    it('refuses bytes it cannot measure, rather than passing them through unbounded', async () => {
      // sharp cannot read BMP, so the hand-off path is the only one that sees
      // it — and it used to hand the bytes over with no dimensions at all,
      // under a contract that promises a ceiling. A header parse is cheap and
      // is not a decode.
      const truncated = Buffer.alloc(20, 0);
      truncated.write('BM', 0);

      await expect(normalizeImage(new Uint8Array(truncated), {}))
        .rejects.toThrow(/dimensions/i);
    });

    it('refuses a sharp-unreadable image that is over the ceiling', async () => {
      // The ceiling is part of the contract for every admitted representation,
      // and we cannot downscale what we cannot decode. Refusing names the file;
      // passing it through would break the promise silently.
      const bmp = Buffer.alloc(54, 0);
      bmp.write('BM', 0);
      bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14);
      bmp.writeInt32LE(4000, 18); bmp.writeInt32LE(4000, 22);

      await expect(normalizeImage(new Uint8Array(bmp), { maxPixels: 10_000 }))
        .rejects.toThrow(/ceiling|too large/i);
    });
  });

  describe('the process-wide gate', () => {
    // The resource is host memory: each concurrent normalization holds a fully
    // decoded bitmap, so N simultaneous uploads cost N bitmaps however small
    // the encoded bytes were. A served host takes uploads from anyone who can
    // reach it.

    it('does not deadlock when more images arrive than there are permits', async () => {
      const src = await solid(80, 60);
      const many = Array.from({ length: MAX_CONCURRENT_NORMALIZATIONS * 3 },
        () => normalizeImage(src, { maxPixels: 2_000 }));

      const out = await Promise.all(many);

      expect(out).toHaveLength(MAX_CONCURRENT_NORMALIZATIONS * 3);
      expect(out.every((o) => o.derived)).toBe(true);
      // An explicit timeout so a leaked permit FAILS here rather than hanging
      // the run: a wedged gate never settles, and a hang names nothing in a CI
      // log while a timeout names this test.
    }, 15_000);

    it('refuses an already-aborted caller without spending a permit', async () => {
      const src = await solid(40, 40);

      await expect(normalizeImage(src, { signal: AbortSignal.abort() }))
        .rejects.toThrow(/abort/i);

      // The permit must not have been consumed — if it were, enough abandoned
      // callers would starve the gate exactly as a leak does.
      const after = await normalizeImage(src, {});
      expect(after.mime).toBe('image/jpeg');
    }, 15_000);

    it('lets a QUEUED caller give up BEFORE any slot frees', async () => {
      // The case the signal exists for, and the assertion has to be about
      // ORDER — asserting only that the queued call rejects proves nothing,
      // because it would also reject after waiting for a slot it no longer
      // wants and noticing on arrival. That is precisely the behaviour the
      // signal replaces, so the test has to tell the two apart.
      //
      // The event to compare against is the FIRST slot freeing, not the last:
      // a caller that waits its turn is granted as soon as any one of the four
      // ahead completes.
      const src = await solid(400, 300);
      const controller = new AbortController();
      const order: string[] = [];

      const busy = Array.from({ length: MAX_CONCURRENT_NORMALIZATIONS },
        () => normalizeImage(src, { maxPixels: 5_000 })
          .then((v) => { order.push('a-slot-freed'); return v; }));
      const queued = normalizeImage(src, { maxPixels: 5_000, signal: controller.signal })
        .then(() => { order.push('queued-resolved'); },
              (e: Error) => { order.push('gave-up'); expect(e.message).toMatch(/abort/i); });

      // Synchronous: the four ahead have taken every permit and none can have
      // finished, so the fifth is certainly still waiting when this fires.
      controller.abort();
      await Promise.all([queued, ...busy]);

      expect(order[0], `expected the abort to land first, got ${order.join(' → ')}`)
        .toBe('gave-up');
      // And the gate is intact afterwards.
      expect((await normalizeImage(src, { maxPixels: 5_000 })).derived).toBe(true);
    }, 20_000);

    it('releases a permit when normalization FAILS', async () => {
      // The failure mode that actually bites: a permit leaked on a rejecting
      // upload. Enough bad files and the gate is exhausted permanently and the
      // host wedges — and bad files are exactly what arrives in volume. So
      // fail more times than there are permits, then require a good image to
      // still get through.
      const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      for (let i = 0; i < MAX_CONCURRENT_NORMALIZATIONS + 2; i++) {
        await expect(normalizeImage(junk, {})).rejects.toThrow();
      }

      const out = await normalizeImage(await solid(40, 40), {});

      expect(out.mime).toBe('image/jpeg');
    }, 15_000);
  });
});