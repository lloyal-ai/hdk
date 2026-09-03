/**
 * @file Normalize an image before it reaches a vision projector.
 *
 * Node only, and one implementation on purpose: every ingress a harness has —
 * a CLI argument, an Electron upload, a browser upload over wss — arrives at
 * harness code running in Node, so one place covers all of them.
 *
 * A browser-side pass would additionally save wire bytes on the web target
 * (base64 inflates an upload by 4/3 before any Node code sees it). That is an
 * optimization for a remote host, not a second half of this contract, and it
 * would be a second implementation to keep in agreement — so it is
 * deliberately not here.
 */

import type { Attachment, Descriptor } from './attachment';
import { DERIVE_PREFIX } from './attachment';
import type { AttachmentStore } from './store';
import type { ContentIngress } from './ingress';
import { PROJECTOR_FORMATS, sniffMediaType, UNKNOWN_MEDIA_TYPE } from './media-type';

/**
 * The default pixel ceiling — mtmd's own (`image_max_pixels`, 2048²).
 *
 * An image above this is downscaled by the projector no matter what, so
 * shipping the original wastes bytes on the wire, work in the decoder, and
 * nothing gained: the model sees the same pixels either way.
 *
 * @category Media
 */
export const DEFAULT_MAX_PIXELS = 4_194_304;

/**
 * The decompression-bomb ceiling — what we are willing to DECODE, as opposed
 * to {@link DEFAULT_MAX_PIXELS}, which is what we are willing to ADMIT.
 *
 * Stated beside its sibling so the two are visibly related: this one is ~24×
 * larger, because a 17 MP camera photo is an ordinary input that must derive
 * successfully, while a 100 MP one is a file crafted to exhaust a host. Nothing
 * set this before, so the only bound was sharp's own ~268 MP default — a number
 * chosen by a library that does not know what a projector will accept.
 *
 * @category Media
 */
export const MAX_INPUT_PIXELS = 100_000_000;

/**
 * How long one decode may take.
 *
 * Distinct from the HTTP body timeout, which bounds TRANSFER: a fully received
 * 200 KB file can still take unbounded time to decode. `sharp.timeout()` was
 * available and unused.
 *
 * @category Media
 */
export const NORMALIZE_TIMEOUT_SECONDS = 20;

/**
 * How many images may be normalized at once, process-wide.
 *
 * The cap belongs to the PROCESS, not the request: each concurrent
 * normalization holds a fully decoded bitmap in memory, so N simultaneous
 * uploads cost N bitmaps regardless of how small the encoded bytes were. A
 * served host takes uploads from anyone who can reach it.
 *
 * @category Media
 */
export const MAX_CONCURRENT_NORMALIZATIONS = 4;

/**
 * How long an image may WAIT for a permit before the host refuses it.
 *
 * An unbounded queue is not a bound: it is a memory leak with a politer name,
 * and it turns any permit accounting bug into a process that hangs forever
 * instead of failing. A busy host should say it is busy.
 *
 * Still earns its keep now that {@link NormalizeOpts.signal} exists: a caller
 * inside a scope gives up the moment that scope halts, but the HTTP ingress
 * route runs in a plain request handler and passes no signal, so this is the
 * only bound it has.
 *
 * Sized well above the worst legitimate wait — a full queue of
 * {@link NORMALIZE_TIMEOUT_SECONDS} decodes — so reaching it means genuine
 * overload or a bug, never ordinary contention.
 *
 * @category Media
 */
export const PERMIT_WAIT_TIMEOUT_MS = 60_000;

/**
 * @category Media
 */
export interface NormalizeOpts {
  /** Downscale (preserving aspect) until width × height fits.
   *  Default {@link DEFAULT_MAX_PIXELS}. */
  maxPixels?: number;
  /** JPEG quality for re-encodes, 1–100. Default 82 — visually clean at a
   *  fraction of the bytes, and a projector is not a photo editor. */
  quality?: number;
  /**
   * Give up when this aborts.
   *
   * A plain `AbortSignal` rather than anything framework-shaped, because this
   * is a BOUNDARY: the harness calls in from inside an Effection scope (which
   * hands out a scope-linked signal via `useAbortSignal()`), and the HTTP
   * ingress route calls in from a plain Node request handler. One standard
   * primitive serves both, and this package stays free of either.
   *
   * Bounds the WAIT for a normalization slot, not the decode — sharp exposes
   * no abort, so {@link NORMALIZE_TIMEOUT_SECONDS} remains the only bound on
   * work already underway.
   */
  signal?: AbortSignal;
}

/**
 * An image, ready for a projector.
 *
 * @category Media
 */
interface NormalizedBase {
  bytes: Uint8Array;
  /** One of {@link PROJECTOR_FORMATS} — guaranteed, or normalizing threw. */
  mime: string;
  /** What the INPUT was, established by decoding it — never by anything a
   *  caller declared. Equal to `mime` on a pass-through and different only
   *  when a derivation happened, which is exactly when a source layer is
   *  written and needs a type of its own.
   *
   *  sharp identifies eight formats where the pure signature table identifies
   *  four, so on the decodable path this is the better answer as well as the
   *  only trustworthy one. */
  sourceMime: string;
  /** What the input measured, so a caller can report what it saved. */
  originalByteLength: number;
}

/**
 * An image, ready for a projector.
 *
 * **Dimensions are always known.** This was a discriminated union while one
 * path could not claim them — the sharp-unreadable hand-off measured nothing —
 * and the union existed to stop `createImageIngress` writing the string
 * `"undefined"` into a derivation annotation. That path now reads dimensions
 * from the header before admitting anything, because a ceiling nobody checks is
 * not a ceiling, so the correlation the union encoded no longer exists and a
 * union that discriminates nothing is just a second shape to read.
 *
 * @category Media
 */
export type NormalizedImage = NormalizedBase & {
  /** Whether the bytes were re-encoded. Decides whether a source layer is
   *  worth retaining and whether a derivation record is truthful — NOT whether
   *  the dimensions are known. */
  derived: boolean;
  width: number;
  height: number;
};

/**
 * Bring an image within a projector's reach: a format it decodes, at a size
 * it will not immediately shrink.
 *
 * **Throws on an image it cannot make acceptable**, rather than passing the
 * bytes through. A file that reaches the projector unreadable fails inside the
 * decoder mid-run, with a worse message and a branch already in flight; a
 * caller here can still tell the user which file to replace.
 *
 * @category Media
 */
export type NormalizeImage = (
  bytes: Uint8Array,
  opts?: NormalizeOpts,
) => Promise<NormalizedImage>;

/**
 * A process-wide gate of {@link MAX_CONCURRENT_NORMALIZATIONS} permits.
 *
 * Module-level on purpose: the resource being protected is host memory, which
 * is shared by every session and every request, so a per-call or per-store
 * limiter would not bound anything.
 */
const gate = {
  permits: MAX_CONCURRENT_NORMALIZATIONS,
  waiting: [] as { grant: () => void; refuse: (e: Error) => void }[],
};

/** The shape a caller can recognise without knowing this module. Matches what
 *  `fetch` throws on abort, because that is what callers already handle. */
const aborted = (): Error => {
  const e = new Error('normalizeImage: aborted');
  e.name = 'AbortError';
  return e;
};

/**
 * Take one of {@link MAX_CONCURRENT_NORMALIZATIONS} permits.
 *
 * `signal` is how a caller that has GIVEN UP stops occupying the queue. That
 * matters more than it sounds: an abandoned request holding a slot is a slot a
 * live request cannot have, so under load the queue fills with work whose
 * results nobody will read. Callers inside an Effection scope get this for
 * free — the scope's own signal aborts on halt.
 *
 * An in-flight sharp decode cannot be interrupted (sharp exposes no abort;
 * {@link NORMALIZE_TIMEOUT_SECONDS} is the only bound on it), so the signal
 * covers the WAIT and the moment before work starts, which is where a
 * cancelled caller's cost actually accumulates.
 */
async function acquire(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw aborted();

  if (gate.permits > 0) {
    gate.permits--;
  } else {
    await new Promise<void>((resolve, reject) => {
      const leave = () => {
        const at = gate.waiting.indexOf(entry);
        if (at >= 0) gate.waiting.splice(at, 1);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => { leave(); reject(aborted()); };
      const entry = {
        grant: () => { leave(); resolve(); },
        refuse: (e: Error) => { leave(); reject(e); },
      };
      const timer = setTimeout(() => entry.refuse(new Error(
        `normalizeImage: waited ${PERMIT_WAIT_TIMEOUT_MS}ms for one of ` +
          `${MAX_CONCURRENT_NORMALIZATIONS} normalization slots and none came free.`,
      )), PERMIT_WAIT_TIMEOUT_MS);
      // Do not hold the process open on account of a queued upload.
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      gate.waiting.push(entry);
    });
  }

  // Granted, but the caller may have given up while it waited. Releasing here
  // hands the permit straight to the next in line instead of spending it on
  // work nobody is waiting for.
  if (signal?.aborted) {
    const next = gate.waiting.shift();
    if (next) next.grant(); else gate.permits++;
    throw aborted();
  }

  let released = false;
  return () => {
    // Idempotent: a double release would MANUFACTURE a permit, which is the
    // same bug as leaking one with the sign flipped.
    if (released) return;
    released = true;
    const next = gate.waiting.shift();
    if (next) next.grant(); else gate.permits++;
  };
}

/**
 * Does this ICC profile describe sRGB?
 *
 * Reads the profile's `desc` tag, which is the only field that answers it:
 * `metadata().space` reports the PIXEL encoding and says `srgb` for a Display
 * P3 image too, so it cannot be used here (verified, sharp 0.35.4).
 *
 * Zero bytes are stripped before matching because a modern profile stores the
 * description as `mluc` — UTF-16BE — where an older one uses ASCII. Anything
 * unparseable answers FALSE, which costs a re-encode and never a wrong colour.
 */
/*
 * KNOWN LIMIT, decided rather than overlooked (2026-09-01).
 *
 * A non-sRGB profile forces DERIVATION, and derivation strips the profile — so
 * every admitted representation ends up with one consistent interpretation.
 * The pixels are NOT converted: sharp 0.35.4 / libvips 8.18.6 performs no ICC
 * transform, measured three ways (`.toColourspace('srgb')`,
 * `.withIccProfile('srgb')`, `.pipelineColourspace('rgb16')`) on a saturated
 * green where P3 and sRGB diverge sharply — all three returned the input
 * pixels unchanged.
 *
 * So a Display P3 photo still reaches the model as P3 numbers read as sRGB.
 * That is what happens on every path today regardless, because `stb_image`
 * ignores ICC entirely. What this fixes is the ASYMMETRY: colour handling used
 * to depend on whether the image happened to exceed the pixel ceiling, which
 * nobody would predict. Do not add a `.toColourspace()` call believing it
 * converts — it does not.
 */
function isSrgbProfile(icc: Uint8Array): boolean {
  try {
    const view = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
    const count = view.getUint32(128);
    for (let i = 0; i < count; i++) {
      const entry = 132 + i * 12;
      const sig = String.fromCharCode(...icc.slice(entry, entry + 4));
      if (sig !== 'desc') continue;
      const at = view.getUint32(entry + 4);
      const size = view.getUint32(entry + 8);
      const text = String.fromCharCode(...icc.slice(at, at + Math.min(size, 256)))
        .replace(/\0+/g, '');
      return /sRGB/i.test(text);
    }
  } catch {
    // A malformed profile is not an sRGB profile.
  }
  return false;
}

/**
 * Dimensions from a BMP header — a read, not a decode.
 *
 * Needed because BMP is the one format the projector reads and sharp does not,
 * so it takes the hand-off path where nothing has measured it. Passing bytes
 * through unmeasured would break the ceiling this function's own contract
 * promises. `null` when the header is not there to read.
 */
function bmpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  // 'BM', then a 14-byte file header, then a DIB header whose width and height
  // sit at 18 and 22 as signed little-endian 32-bit integers.
  if (bytes.byteLength < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getInt32(18, true);
  // Height is negative for a top-down bitmap; the magnitude is what counts.
  const height = Math.abs(view.getInt32(22, true));
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Normalize an image for a vision projector.
 *
 * Two guarantees, both of which the projector otherwise enforces too late:
 *
 * - **Format.** The result is one of {@link PROJECTOR_FORMATS}. A file picker's
 *   `accept` is advisory — drag-and-drop and paste bypass it — so without this
 *   an unsupported file fails inside the decoder, mid-run, on a branch already
 *   in flight.
 * - **Size.** Anything above `maxPixels` is downscaled here rather than by the
 *   projector, which would do it anyway after the bytes had already crossed a
 *   socket and been decoded. The model sees the same pixels either way.
 *
 * Re-encodes only when it must: an image already in an accepted format and
 * already within the ceiling comes back with its original bytes untouched, so
 * normalizing costs nothing in the common case and never degrades an image
 * twice across repeated calls.
 *
 * @throws If the bytes are not a decodable image — the caller can still name
 *         the file to replace, which nothing downstream can.
 *
 * @category Media
 */
export const normalizeImage: NormalizeImage = async (bytes, opts = {}) => {
  const maxPixels = opts.maxPixels ?? DEFAULT_MAX_PIXELS;
  const quality = opts.quality ?? 82;

  // Required at call time, not imported at module load: `sharp` is a native
  // dependency, and a harness that never accepts an image should not pay its
  // load. The message names the package because the failure is a missing
  // install, not a bad picture.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  let sharp: typeof import('sharp').default;
  try {
    // sharp's CJS export is the callable itself; its types put it on `default`.
    sharp = require('sharp');
  } catch {
    throw new Error(
      'normalizeImage: `sharp` is not installed. Add it to the harness that ' +
        'accepts image uploads (npm i sharp), or hand the projector bytes ' +
        `that are already ${PROJECTOR_FORMATS.map(f => f.replace(/^image\//, '')).join('/')} ` +
        'and within its pixel ceiling.',
    );
  }

  // A decompression bomb is a small file that declares an enormous image.
  // Without this the only bound was sharp's ~268 MP default.
  // Everything from here holds a decoded bitmap, so it runs under the
  // process-wide gate. Released in a `finally`: a permit leaked on a FAILING
  // upload is the failure mode that matters — a handful of bad files would
  // exhaust the gate permanently and wedge the host, and bad files are exactly
  // what arrives in volume.
  const release = await acquire(opts.signal);
  try {
  const input = sharp(bytes, { animated: false, limitInputPixels: MAX_INPUT_PIXELS })
    .timeout({ seconds: NORMALIZE_TIMEOUT_SECONDS });
  let meta;
  try {
    meta = await input.metadata();
  } catch (err) {
    // sharp and the projector read OVERLAPPING but different sets. sharp reads
    // webp/heif/tiff/svg, which the projector cannot; the projector reads
    // bmp/tga/psd/hdr/pic/pnm, which sharp cannot. Refusing everything sharp
    // fails on would cost a user their whole query for a file the model reads
    // perfectly well.
    //
    // Handing bytes over is safe: `MtmdSource`'s constructor decodes every
    // bitmap BEFORE `mtmd_tokenize` and before any `decode_segments`, throwing
    // with the offending index and the branch untouched
    // (`liblloyal/include/lloyal/mtmd.hpp`). An unreadable file fails at the
    // same phase either way — this only decides who reports it.
    //
    // But only what we can IDENTIFY. The gate is the INTERSECTION of the two
    // lists: sniffable AND projector-readable. Of the projector's exotics that
    // is bmp alone — tga/psd/hdr/pic/pnm have no signature here, so they are
    // refused rather than admitted unidentified and unmeasured. An earlier
    // version tested `PROJECTOR_FORMATS.includes(...)` while that constant was
    // DERIVED from the sniff table, so it read as covering six formats and
    // covered one.
    const sniffed = sniffMediaType(bytes);
    if (sniffed === UNKNOWN_MEDIA_TYPE || !PROJECTOR_FORMATS.includes(sniffed)) throw err;

    // Identified, but nothing has MEASURED it — and the ceiling is part of the
    // contract for every admitted representation, not only for what sharp can
    // read. A header parse is cheap and is not a decode. Refusing names the
    // file the user must replace; passing it through would break a promise
    // this function makes, silently, on the one path nobody can downscale.
    const dims = bmpDimensions(bytes);
    if (!dims) {
      throw new Error(
        `normalizeImage: ${sniffed} is a format the projector reads but sharp ` +
          'cannot, and its dimensions could not be established from the header, ' +
          'so it cannot be admitted under a pixel ceiling.',
      );
    }
    // The ABSOLUTE ceiling first — the same one sharp enforces on every other
    // format through limitInputPixels. A caller may raise maxPixels; it may
    // not open a decompression-bomb door the sharp path keeps shut.
    if (dims.width * dims.height > MAX_INPUT_PIXELS) {
      throw new Error(
        `normalizeImage: ${dims.width}x${dims.height} exceeds the absolute ` +
          `${MAX_INPUT_PIXELS}-pixel ceiling.`,
      );
    }
    if (dims.width * dims.height > maxPixels) {
      throw new Error(
        `normalizeImage: ${dims.width}x${dims.height} exceeds the ${maxPixels}-pixel ` +
          `ceiling, and ${sniffed} cannot be downscaled here — sharp does not read ` +
          'it. Convert it to PNG or JPEG first.',
      );
    }
    return {
      bytes, derived: false, mime: sniffed, sourceMime: sniffed,
      width: dims.width, height: dims.height, originalByteLength: bytes.byteLength,
    };
  }
  // EXIF orientations 5-8 mean the stored pixels are transposed relative to
  // how the image is meant to be seen. Since `.autoOrient()` below rotates
  // BEFORE the resize, every measurement here has to be in DISPLAY terms — a
  // ceiling computed on stored dimensions would be applied to a rotated image
  // and miss by the aspect ratio.
  const swapped = (meta.orientation ?? 1) >= 5;
  const w = (swapped ? meta.height : meta.width) ?? 0;
  const h = (swapped ? meta.width : meta.height) ?? 0;
  if (w === 0 || h === 0) {
    throw new Error('normalizeImage: not a decodable image (no dimensions)');
  }

  // sharp names the format exactly as the mime subtype (`jpeg`, not `jpg`),
  // so this is a prefix and not a translation table.
  const mime = meta.format ? `image/${meta.format}` : '';
  const pixels = w * h;

  // THE ADMISSION POLICY. Byte-identical pass-through is permitted only when
  // every one of these holds; otherwise the image is DERIVED and the original
  // is retained as the source layer.
  //
  // The last two are not precautionary. `stb_image.h` — what mtmd loads with —
  // contains zero EXIF/orientation matches and mtmd applies no rotation around
  // `stbi_load_from_memory`; it ignores ICC entirely. So a tag we leave on is a
  // tag NOBODY downstream reads, and a phone JPEG small enough to pass through
  // reaches the model sideways with nothing left to say so. Size was never what
  // made that safe or unsafe — which is exactly the asymmetry this removes.
  const orientation = meta.orientation ?? 1;
  const colourSafe = !meta.icc || isSrgbProfile(meta.icc);
  const admissible =
    PROJECTOR_FORMATS.includes(mime)
    && pixels <= maxPixels
    && orientation === 1
    && colourSafe;

  if (admissible) {
    return { bytes, derived: false, mime, sourceMime: mime, width: w, height: h, originalByteLength: bytes.byteLength };
  }

  // Preserve aspect: sharp fits inside the box, so deriving one side from the
  // area ratio and letting it compute the other keeps the ratio exact.
  const scale = pixels > maxPixels ? Math.sqrt(maxPixels / pixels) : 1;
  const width = Math.max(1, Math.floor(w * scale));

  const out = await input
    // Apply EXIF orientation to the PIXELS before anything else. Re-encoding
    // drops the tag (sharp strips metadata by default), so without this a
    // portrait phone photo — `Orientation=6`, the common case — reaches the
    // projector rotated 90° with nothing left to say so. Irrecoverable: the
    // model sees a sideways image and cannot know it.
    .autoOrient()
    .resize({ width, withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer({ resolveWithObject: true });

  return {
    bytes: new Uint8Array(out.data),
    derived: true,
    mime: 'image/jpeg',
    sourceMime: mime,
    width: out.info.width,
    height: out.info.height,
    originalByteLength: bytes.byteLength,
  };
  } finally {
    release();
  }
};

/**
 * Identifies the normalization that produced a representation.
 *
 * Bumped whenever the pipeline's OUTPUT BYTES could change for the same input
 * and options — a different resize kernel, a different encoder default. It is
 * part of the derivation identity because "was this derived under the
 * parameters now in force?" cannot be answered from the options alone.
 */
const PROFILE = 'image.v1';

/**
 * The image ingress: normalize, commit source + representation, return the root.
 *
 * This is the ONE place raw media becomes admitted content, shared by all three
 * ingresses — a browser upload arriving over HTTP, a spine's standing
 * reference material, and a tool's result. Wiring it into only one of them
 * would leave the others feeding unnormalized bytes to the projector with no
 * derivation recorded.
 *
 * **Order is commit-then-return, and callers must prefill only after.**
 * Normalizing and committing before the prefill means a failure costs nothing
 * but an orphan blob; committing after would mean a failed write leaves media
 * in the cache that can never be replayed. The write-order invariant already
 * accepts orphans — "harmless orphan blobs, never a committed manifest
 * pointing at absent content."
 *
 * **The source is retained by default**, so a representation can be re-derived
 * later under a better sampler or for a model that reads the original
 * natively. It is skipped only when normalization was a no-op and the two
 * would be the same blob.
 *
 * @param store - The project content store.
 * @param opts - Normalization options; recorded verbatim into the manifest.
 *
 * @category Media
 */
export function createImageIngress(
  store: AttachmentStore,
  opts: NormalizeOpts = {},
): ContentIngress {
  return {
    async ingest(bytes: Uint8Array, signal?: AbortSignal): Promise<Attachment> {
      // Admission converts what the projector cannot read and lets everything
      // else through untouched — it is not a validation gate. It is not a
      // resource boundary either: the transport bounds body size before this.
      const norm = await normalizeImage(bytes, { ...opts, ...(signal ? { signal } : {}) });

      // A derivation record describes a derivation that HAPPENED. Writing it
      // on a pass-through would annotate bytes nobody re-encoded with a
      // quality and a ceiling that never applied to them — and since these
      // annotations exist so a later reader can ask "was this derived under
      // the parameters now in force?", a false one is worse than none.
      const derived: Record<string, string> = norm.derived
        ? {
            [`${DERIVE_PREFIX}profile`]: PROFILE,
            [`${DERIVE_PREFIX}maxPixels`]: String(opts.maxPixels ?? DEFAULT_MAX_PIXELS),
            [`${DERIVE_PREFIX}quality`]: String(opts.quality ?? 82),
            [`${DERIVE_PREFIX}width`]: String(norm.width),
            [`${DERIVE_PREFIX}height`]: String(norm.height),
            [`${DERIVE_PREFIX}format`]: norm.mime,
          }
        : {};

      // No null check: a store write that cannot happen THROWS, carrying the
      // real reason. This used to translate a null into a generic sentence,
      // which is how "read-only volume" and "disk full" became the same
      // message — the store knows which; only it ever did.
      const representation = store.putBlob(norm.bytes, norm.mime, derived);

      // No derivation, no source layer: the two blobs would be byte-identical
      // and the second would say nothing. `normalizeImage` decides.
      let source: Descriptor | undefined;
      if (norm.derived) {
        // A failed source write is a failure, not an absence. `?? undefined`
        // here meant a retained original could vanish and the manifest commit
        // anyway — the user's own file dropped, silently, while the
        // representation's failure threw. One convention, both writes.
        source = store.putBlob(bytes, norm.sourceMime);
      }

      return store.putAttachment({
        representations: [representation],
        ...(source ? { source } : {}),
      });
    },
  };
}
