/**
 * A host that decodes video without a canvas encodes each frame through
 * media, so its frames are the page's: JPEG, at the decoded frame's size.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { encodeVideoFrame } from '../src/video-frame';
import { imageSize, sniffMediaType } from '../src/media-type';

const decoded = new Uint8Array(readFileSync(join(__dirname, 'fixtures/video/frame-00.png')));

describe('encodeVideoFrame', () => {
  it('encodes a decoded frame as a JPEG of the same size', async () => {
    const frame = await encodeVideoFrame(decoded);
    expect(sniffMediaType(frame)).toBe('image/jpeg');
    expect(imageSize(frame)).toEqual(imageSize(decoded));
  });

  it('encodes at the quality the page encodes at, the same bytes each time', async () => {
    const [a, b] = await Promise.all([encodeVideoFrame(decoded), encodeVideoFrame(decoded)]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    // A canvas takes the page's quality as 0.85; sharp takes the same quality as 85.
    expect(Buffer.from(a).equals(await sharp(decoded).jpeg({ quality: 85 }).toBuffer())).toBe(true);
  });
});
