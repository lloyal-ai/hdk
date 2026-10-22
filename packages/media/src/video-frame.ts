/**
 * @file A video frame encoded on a host, as the page encodes one.
 *
 * The page encodes each sampled frame on a canvas; a host or a tool that
 * decodes video without one encodes it here, at the same quality, so its
 * frames are the page's.
 */
import { loadSharp } from './sharp';
import { FRAME_JPEG_QUALITY } from './video';

/**
 * A decoded video frame encoded as the page encodes one: JPEG at the page's
 * quality, at the size it was decoded to. For a host that decodes video
 * without a canvas.
 *
 * @category Media
 */
export async function encodeVideoFrame(frame: Uint8Array): Promise<Uint8Array> {
  const sharp = loadSharp('encodeVideoFrame: `sharp` is not installed. Add it to the host that decodes video (npm i sharp).');
  return new Uint8Array(await sharp(frame).jpeg({ quality: Math.round(FRAME_JPEG_QUALITY * 100) }).toBuffer());
}
