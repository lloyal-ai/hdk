/**
 * @file Identify a content format from its leading bytes.
 *
 * Its own file because it depends on nothing else in the content surface. The
 * image normalizer consults it on a decode error, and the content ingress
 * dispatches on it: the bytes say what they are, a caller never does.
 */

type Signature = { mediaType: string; magic: readonly number[]; at?: { offset: number; magic: readonly number[] } };

/** An ISO BMFF file's `ftyp` box at offset 4, followed by its major brand. */
const isoBrand = (mediaType: string, brand: string): Signature =>
  ({ mediaType, magic: [], at: { offset: 4, magic: [...new TextEncoder().encode(`ftyp${brand}`)] } });

/**
 * HEIF and AVIF stills share the ISO BMFF box with mp4, so their major brands
 * are named before the generic `ftyp` match: a photo keeps the image path,
 * where sharp converts what it can read.
 */
const STILL_BRANDS: Readonly<Record<string, string>> = {
  heic: 'image/heic', heix: 'image/heic', hevc: 'image/heic-sequence', hevx: 'image/heic-sequence',
  mif1: 'image/heif', msf1: 'image/heif-sequence', avif: 'image/avif', avis: 'image/avif',
};

/**
 * Formats this package identifies by their leading bytes: the four image
 * formats the projector decodes, PDF, WAV, the HEIF and AVIF stills sharp
 * converts, and the video containers.
 *
 * A table rather than a chain of ifs. Anything unmatched is still stored —
 * validating pixels belongs to the normalizer that runs before ingress, and to
 * the decoder, both of which fail with a better message than this could.
 */
const SIGNATURES: readonly Signature[] = [
  { mediaType: 'audio/wav', magic: [0x52, 0x49, 0x46, 0x46], at: { offset: 8, magic: [0x57, 0x41, 0x56, 0x45] } },
  { mediaType: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { mediaType: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mediaType: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { mediaType: 'image/bmp', magic: [0x42, 0x4d] },
  // `%PDF-`. Not a projector format (see below): the content ingress routes it
  // to the document ingress; the image normalizer refuses it as it refuses any
  // format it cannot decode.
  { mediaType: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  ...Object.entries(STILL_BRANDS).map(([brand, mediaType]) => isoBrand(mediaType, brand)),
  // Video containers, identified so the single-payload ingress can refuse them
  // by name: a clip is decoded on the page and arrives as frames. QuickTime's
  // brand is `qt  `; any other ISO BMFF brand is taken as mp4.
  isoBrand('video/quicktime', 'qt  '),
  isoBrand('video/mp4', ''),
  { mediaType: 'video/webm', magic: [0x1a, 0x45, 0xdf, 0xa3] },
];

/**
 * The video containers {@link sniffMediaType} identifies. None is a projector
 * format: a video reaches the model as its decoded frames.
 *
 * @category Media
 */
export const VIDEO_CONTAINER_TYPES: readonly string[] = ['video/mp4', 'video/quicktime', 'video/webm'];

/**
 * Pixel dimensions read from a PNG or JPEG header, or null for any other
 * format or a header too short to say. Pure, so a composer that must check
 * frames share one size can do it without a decoder.
 *
 * @category Media
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = sniffMediaType(bytes);
  if (type === 'image/png') {
    return bytes.length >= 24 ? { width: view.getUint32(16), height: view.getUint32(20) } : null;
  }
  if (type !== 'image/jpeg') return null;
  // Walk the marker segments to the first start-of-frame; its header carries
  // the size. SOF markers are C0–CF except C4 (DHT), C8 (JPG) and CC (DAC).
  for (let at = 2; at + 9 <= bytes.length;) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    if (marker === 0xff) { at += 1; continue; }
    const length = view.getUint16(at + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
    at += 2 + length;
  }
  return null;
}

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
  const matches = (magic: readonly number[], offset = 0): boolean => magic.every((b, i) => bytes[offset + i] === b);
  return SIGNATURES.find(s => matches(s.magic) && (!s.at || matches(s.at.magic, s.at.offset)))?.mediaType
    ?? UNKNOWN_MEDIA_TYPE;
}

/**
 * The image formats the vision projector decodes.
 *
 * **Its own list, deliberately NOT derived from {@link SIGNATURES}.** These are
 * two different questions and they have different answers:
 *
 * - `SIGNATURES` — "what can I identify from leading bytes?" Four image formats and PDF.
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
