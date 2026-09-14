/**
 * One origin, every door. The client half of the content plane derives each
 * URL from the origin the bridge reports, in the host's route grammar — so a
 * target that reports an origin inherits every route, and the citation
 * grammar the documents ability emits resolves only against digests the view
 * already holds, exactly one of them.
 */
import { describe, it, expect } from 'vitest';
import {
  configUrl, ingressUrl, manifestUrl, parseAttachmentHref, representationUrl, resolvePrefix, sourceUrl,
} from '../src/content-urls';

const DIGEST = 'sha256:' + 'a1b2c3d4e5f6'.padEnd(64, '0');

describe('content urls', () => {
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

  it('a prefix resolves to exactly one digest the view holds, or to nothing', () => {
    const other = 'sha256:' + 'a1b2c3d4e5f6'.padEnd(64, '1');
    expect(resolvePrefix('a1b2c3d4e5f6', [DIGEST])).toBe(DIGEST);
    expect(resolvePrefix('a1b2c3d4e5f6', [DIGEST, other])).toBeNull();
    expect(resolvePrefix('a1b2c3d4e5f6', [])).toBeNull();
    expect(resolvePrefix('ffffff', [DIGEST])).toBeNull();
  });
});
