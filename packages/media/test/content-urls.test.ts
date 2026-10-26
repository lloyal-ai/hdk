/**
 * One origin, every door. The client half of the content plane derives each
 * URL from the origin the bridge reports, in the host's route grammar — so a
 * target that reports an origin inherits every route, and the citation
 * grammar the documents ability emits resolves only against digests the view
 * already holds, exactly one of them.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ATTACHMENT_SCHEME, configUrl, ingestMedia, ingressUrl, isAttachmentUrl, manifestUrl, parseAttachmentHref, parseAttachmentMoment,
  representationUrl, resolvePrefix, sourceUrl,
} from '../src/content-urls';

const DIGEST = 'sha256:' + 'a1b2c3d4e5f6'.padEnd(64, '0');

describe('content urls', () => {
  it('passes cancellation to the existing upload request', async () => {
    const controller = new AbortController();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    try {
      await ingestMedia('', new Uint8Array([1, 2]), { signal: controller.signal });
      expect(fetch.mock.calls[0][1]?.signal).toBe(controller.signal);
    } finally {
      fetch.mockRestore();
    }
  });
  it('every door derives from one origin and matches the route grammar', () => {
    const origin = 'http://host:8787';
    expect(ingressUrl(origin)).toBe('http://host:8787/v1/media/ingress');
    expect(manifestUrl(origin, DIGEST)).toBe(`http://host:8787/v1/media/${encodeURIComponent(DIGEST)}`);
    expect(configUrl(origin, DIGEST)).toBe(`http://host:8787/v1/media/${encodeURIComponent(DIGEST)}/config`);
    expect(representationUrl(origin, DIGEST)).toBe(`http://host:8787/v1/media/${encodeURIComponent(DIGEST)}/representations/0`);
    expect(representationUrl(origin, DIGEST, 2)).toBe(`http://host:8787/v1/media/${encodeURIComponent(DIGEST)}/representations/2`);
    expect(sourceUrl(origin, DIGEST)).toBe(`http://host:8787/v1/media/${encodeURIComponent(DIGEST)}/source`);
    // The relative origin (a dev proxy) is the empty string, and stays same-origin.
    expect(ingressUrl('')).toBe('/v1/media/ingress');
    for (const url of [manifestUrl(origin, DIGEST), configUrl(origin, DIGEST), sourceUrl(origin, DIGEST), representationUrl(origin, DIGEST, 1)]) {
      expect(url).toMatch(/^http:\/\/host:8787\/v1\/media\/sha256%3A[0-9a-f]{64}(\/config|\/source|\/representations\/\d+)?$/);
    }
  });

  it('the citation grammar: a hex prefix and a page, nothing else', () => {
    expect(parseAttachmentHref('attachment://a1b2c3d4e5f6/page/7')).toEqual({ prefix: 'a1b2c3d4e5f6', page: 7 });
    expect(parseAttachmentHref('attachment://A1B2C3D4E5F6/page/1')).toEqual({ prefix: 'a1b2c3d4e5f6', page: 1 });
    expect(parseAttachmentHref('attachment://not-hex/page/7')).toBeNull();
    expect(parseAttachmentHref('attachment://a1b2c3d4e5f6/page/')).toBeNull();
    expect(parseAttachmentHref('attachment://a1b2c3d4e5f6')).toBeNull();
    expect(parseAttachmentHref('https://example.com/attachment://a1b2c3d4e5f6/page/7')).toBeNull();
  });

  it('the scheme is the content plane\'s in any case, and nothing that only resembles it', () => {
    for (const url of ['attachment://a1b2c3d4e5f6', 'Attachment://store', 'ATTACHMENT://a1b2c3d4e5f6/t/5000']) expect(isAttachmentUrl(url), url).toBe(true);
    for (const url of ['attachments://a1', 'attachment:a1', 'https://attachment://a1', ' attachment://a1', '']) expect(isAttachmentUrl(url), url).toBe(false);
    expect(parseAttachmentHref(`${ATTACHMENT_SCHEME.toUpperCase()}a1b2c3d4e5f6/page/2`)).toEqual({ prefix: 'a1b2c3d4e5f6', page: 2 });
    expect(parseAttachmentMoment('aTtAcHmEnT://a1b2c3d4e5f6/t/0m5.00s')).toEqual({ prefix: 'a1b2c3d4e5f6', tMs: 5000 });
  });

  it('a prefix resolves to exactly one digest the view holds, or to nothing', () => {
    const other = 'sha256:' + 'a1b2c3d4e5f6'.padEnd(64, '1');
    expect(resolvePrefix('a1b2c3d4e5f6', [DIGEST])).toBe(DIGEST);
    expect(resolvePrefix('a1b2c3d4e5f6', [DIGEST, other])).toBeNull();
    expect(resolvePrefix('a1b2c3d4e5f6', [])).toBeNull();
    expect(resolvePrefix('ffffff', [DIGEST])).toBeNull();
  });
});

describe('parseAttachmentMoment', () => {
  it('reads a moment in a video in the citation grammar, and nothing else', async () => {
    const { parseAttachmentMoment } = await import('../src/content-urls');
    expect(parseAttachmentMoment('attachment://ABCDEF012345/t/4250')).toEqual({ prefix: 'abcdef012345', tMs: 4250 });
    // The form the model reads in the video's own timestamps, and so the one it cites in.
    expect(parseAttachmentMoment('attachment://abcdef012345/t/0m5.00s')).toEqual({ prefix: 'abcdef012345', tMs: 5000 });
    expect(parseAttachmentMoment('attachment://abcdef012345/t/1m2.50s')).toEqual({ prefix: 'abcdef012345', tMs: 62500 });
    expect(parseAttachmentMoment('attachment://abcdef012345/page/3')).toBeNull();
    expect(parseAttachmentMoment('attachment://abc/t/1')).toBeNull();
    // A time no seek can reach is no moment.
    expect(parseAttachmentMoment(`attachment://abcdef012345/t/${'9'.repeat(400)}`)).toBeNull();
    expect(parseAttachmentMoment(`attachment://abcdef012345/t/${'9'.repeat(20)}m0.00s`)).toBeNull();
  });
});
