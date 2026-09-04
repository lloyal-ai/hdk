/**
 * @file Identify an image format from its leading bytes.
 *
 * Its own file because it depends on nothing else in the content surface, and
 * because `spine.ts` and `agent-pool.ts` already import it on its own — the
 * callers treated it as a separate module before it was one.
 */

/**
 * The image formats a vision projector decodes, by their leading bytes.
 *
 * A table rather than a chain of ifs. Anything unmatched is still stored —
 * validating pixels belongs to the normalizer that runs before ingress, and to
 * the decoder, both of which fail with a better message than this could.
 */
const SIGNATURES: ReadonlyArray<{ mediaType: string; magic: readonly number[] }> = [
  { mediaType: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { mediaType: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mediaType: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { mediaType: 'image/bmp', magic: [0x42, 0x4d] },
];

/**
 * Best-effort media type from leading bytes, for a caller that has none.
 *
 * @category Media
 */
/** What {@link sniffMediaType} returns when no signature matches. Named because
 *  callers branch on it — a bare literal at each site is how a sentinel and its
 *  producer drift apart. */
export const UNKNOWN_MEDIA_TYPE = 'application/octet-stream';

export function sniffMediaType(bytes: Uint8Array): string {
  return SIGNATURES.find(s => s.magic.every((b, i) => bytes[i] === b))?.mediaType
    ?? UNKNOWN_MEDIA_TYPE;
}

/**
 * The image formats the vision projector decodes.
 *
 * **Its own list, deliberately NOT derived from {@link SIGNATURES}.** These are
 * two different questions and they have different answers:
 *
 * - `SIGNATURES` — "what can I identify from leading bytes?" Four formats.
 * - `PROJECTOR_FORMATS` — "what will mtmd decode?" Nine.
 *
 * Ground truth for this list is the kernel, not an assumption:
 * `mtmd-helper.cpp` loads through `stbi_load_from_memory` and sets no
 * `STBI_NO_*` / `STBI_ONLY_*` defines, so every stb_image decoder is compiled
 * in. An earlier version derived this from the sniff table with a `.map()` and
 * a comment claiming the two "cannot drift apart" — true, and precisely the
 * problem: it made them provably equal when they are not, and a rescue path
 * that named six formats could reach exactly one.
 *
 * Admitting bytes needs BOTH answers: a format we can identify AND the
 * projector can read. That intersection is computed where it is used, not
 * baked in here.
 *
 * @category Media
 */
export const PROJECTOR_FORMATS: readonly string[] = [
  // Sniffable (see SIGNATURES) and projector-readable.
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/bmp',
  // Projector-readable, but we carry no signature for them — so they are
  // refused at ingress rather than handed over unidentified. Listed because
  // this constant answers "what does the decoder read?", which is a fact about
  // mtmd and stays true whatever we can sniff.
  'image/x-tga',
  'image/vnd.adobe.photoshop',
  'image/vnd.radiance',
  'image/x-softimage-pic',
  'image/x-portable-anymap',
];
