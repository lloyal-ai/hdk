/**
 * Tests for the embedded Cloudflare Access OAuth client used by
 * `harness.dev publish`. Covers the pure + fetch-mockable surface of
 * the loopback-OAuth flow. The actual browser-open + redirect capture
 * is exercised by the manual smoke (Q.5) — too hard to mock cleanly,
 * and the harness developer running publish for the first time IS the
 * authoritative test.
 *
 * @category Testing
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  __test,
  discoverEndpoints,
  ensureFreshToken,
  generatePKCE,
  refreshAccessToken,
  registerClient,
  type OAuthTokens,
} from '../src/cf-access-oauth';

// ── Test cache dir (overrides ~/.harness.dev) ────────────────────

let cacheRoot: string;

beforeEach(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), 'harness-dev-oauth-test-'));
  __test.setCachePath(cacheRoot);
});

afterEach(async () => {
  __test.resetCachePath();
  vi.unstubAllGlobals();
  await rm(cacheRoot, { recursive: true, force: true });
});

// ── PKCE ─────────────────────────────────────────────────────────

describe('generatePKCE', () => {
  it('produces a code_challenge that is base64url(SHA-256(code_verifier))', () => {
    const { code_verifier, code_challenge } = generatePKCE();
    const expected = base64UrlEncodeBuf(createHash('sha256').update(code_verifier).digest());
    expect(code_challenge).toBe(expected);
  });

  it('produces a code_challenge starting with [a-zA-Z0-9] (Cloudflare URL-parsing quirk)', () => {
    // Run several times to defend against the alphanumeric-leading reroll being
    // accidentally weakened.
    for (let i = 0; i < 25; i++) {
      const { code_challenge } = generatePKCE();
      expect(code_challenge[0]).toMatch(/[a-zA-Z0-9]/);
    }
  });

  it('produces a code_verifier and challenge that are URL-safe base64', () => {
    const { code_verifier, code_challenge } = generatePKCE();
    expect(code_verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(code_challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(code_verifier).not.toContain('=');
    expect(code_challenge).not.toContain('=');
  });
});

// ── Discovery ────────────────────────────────────────────────────

describe('discoverEndpoints', () => {
  it('follows RFC 9728 + RFC 8414 to resolve registration/authorization/token endpoints', async () => {
    const resourceUrl = 'https://apps.lloyal.ai/v1/publish';
    const resourceMetadataUrl = 'https://apps.lloyal.ai/.well-known/cloudflare-access-protected-resource/v1/publish';
    const authServer = 'https://lloyal.cloudflareaccess.com';

    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (url === resourceUrl && (init?.method ?? 'GET') === 'HEAD') {
          return new Response(null, {
            status: 401,
            headers: { 'www-authenticate': `Bearer realm="OAuth", resource_metadata="${resourceMetadataUrl}"` },
          });
        }
        if (url === resourceMetadataUrl) {
          return new Response(
            JSON.stringify({ resource: 'https://apps.lloyal.ai', authorization_servers: [authServer] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url === `${authServer}/.well-known/oauth-authorization-server`) {
          return new Response(
            JSON.stringify({
              registration_endpoint: `${authServer}/cdn-cgi/access/oauth/register`,
              authorization_endpoint: `${authServer}/cdn-cgi/access/oauth/authorize`,
              token_endpoint: `${authServer}/cdn-cgi/access/oauth/token`,
              code_challenge_methods_supported: ['S256'],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('not found', { status: 404 });
      }),
    );

    const endpoints = await discoverEndpoints(resourceUrl);
    expect(endpoints).toEqual({
      registration_endpoint: `${authServer}/cdn-cgi/access/oauth/register`,
      authorization_endpoint: `${authServer}/cdn-cgi/access/oauth/authorize`,
      token_endpoint: `${authServer}/cdn-cgi/access/oauth/token`,
      resource: 'https://apps.lloyal.ai',
      authorization_server: authServer,
    });
    // Order matters: HEAD resource → GET resource-metadata → GET .well-known
    expect(calls).toEqual([
      `HEAD ${resourceUrl}`,
      `GET ${resourceMetadataUrl}`,
      `GET ${authServer}/.well-known/oauth-authorization-server`,
    ]);
  });

  it('rejects when www-authenticate header is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await expect(discoverEndpoints('https://apps.lloyal.ai/v1/publish')).rejects.toThrow(
      /no www-authenticate header/,
    );
  });

  it('rejects when authorization server does not advertise S256 PKCE support', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'HEAD') {
          return new Response(null, {
            status: 401,
            headers: { 'www-authenticate': 'Bearer resource_metadata="https://x/y"' },
          });
        }
        if (url === 'https://x/y') {
          return new Response(JSON.stringify({ authorization_servers: ['https://a'] }), { status: 200 });
        }
        if (url === 'https://a/.well-known/oauth-authorization-server') {
          return new Response(
            JSON.stringify({
              registration_endpoint: 'https://a/reg',
              authorization_endpoint: 'https://a/auth',
              token_endpoint: 'https://a/tok',
              code_challenge_methods_supported: ['plain'],
            }),
            { status: 200 },
          );
        }
        return new Response('not found', { status: 404 });
      }),
    );
    await expect(discoverEndpoints('https://apps.lloyal.ai/v1/publish')).rejects.toThrow(
      /does not advertise S256 PKCE support/,
    );
  });
});

// ── Dynamic client registration ──────────────────────────────────

describe('registerClient', () => {
  it('POSTs an RFC 7591-compliant body and extracts client_id', async () => {
    const endpoints = sampleEndpoints();
    const redirectUri = 'http://127.0.0.1:51234/callback';
    let postedBody: string | undefined;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe(endpoints.registration_endpoint);
        expect(init?.method).toBe('POST');
        expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
        postedBody = init?.body as string;
        return new Response(
          JSON.stringify({ client_id: 'client-abc-123', redirect_uris: [redirectUri] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const clientId = await registerClient(endpoints, redirectUri);
    expect(clientId).toBe('client-abc-123');

    const parsed = JSON.parse(postedBody!) as Record<string, unknown>;
    expect(parsed.redirect_uris).toEqual([redirectUri]);
    expect(parsed.token_endpoint_auth_method).toBe('none');
    expect(parsed.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(parsed.response_types).toEqual(['code']);
    expect(parsed.resource).toBe(endpoints.resource);
  });
});

// ── Refresh ──────────────────────────────────────────────────────

describe('refreshAccessToken', () => {
  it('POSTs grant_type=refresh_token and returns updated tokens', async () => {
    const endpoints = sampleEndpoints();
    const before = sampleTokens();
    const newAccess = 'oauth:new-access-token';
    const newRefresh = 'oauth:new-refresh-token';

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe(endpoints.token_endpoint);
        expect(init?.method).toBe('POST');
        expect((init?.headers as Record<string, string>)['content-type']).toBe(
          'application/x-www-form-urlencoded',
        );
        const body = new URLSearchParams(init?.body as string);
        expect(body.get('grant_type')).toBe('refresh_token');
        expect(body.get('refresh_token')).toBe(before.refresh_token);
        expect(body.get('client_id')).toBe(before.client_id);
        return new Response(
          JSON.stringify({
            access_token: newAccess,
            refresh_token: newRefresh,
            expires_in: 900,
            token_type: 'bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const after = await refreshAccessToken(endpoints, before);
    expect(after.access_token).toBe(newAccess);
    expect(after.refresh_token).toBe(newRefresh);
    expect(after.expires_at).toBeGreaterThan(Date.now());
    expect(after.client_id).toBe(before.client_id);
    expect(after.team_domain).toBe(before.team_domain);
  });

  it('reuses the previous refresh_token when the server omits a new one (RFC 6749 §6)', async () => {
    const endpoints = sampleEndpoints();
    const before = sampleTokens();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ access_token: 'oauth:new-a', expires_in: 900 }), { status: 200 }),
      ),
    );
    const after = await refreshAccessToken(endpoints, before);
    expect(after.refresh_token).toBe(before.refresh_token);
  });
});

// ── ensureFreshToken cache orchestration ─────────────────────────

describe('ensureFreshToken cache orchestration', () => {
  it('returns the cached access_token when it has > 60s of life remaining', async () => {
    const cached: OAuthTokens = { ...sampleTokens(), expires_at: Date.now() + 3_600_000 };
    await writeFile(__test.cacheFile, JSON.stringify(cached));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const access = await ensureFreshToken('https://apps.lloyal.ai/v1/publish');
    expect(access).toBe(cached.access_token);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes when the cached token is expired and a refresh_token is present', async () => {
    const cached: OAuthTokens = { ...sampleTokens(), expires_at: Date.now() - 60_000 };
    await writeFile(__test.cacheFile, JSON.stringify(cached));

    const resourceUrl = 'https://apps.lloyal.ai/v1/publish';
    const resourceMetadataUrl = 'https://apps.lloyal.ai/.well-known/cloudflare-access-protected-resource/v1/publish';
    const authServer = cached.authorization_server;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === resourceUrl && (init?.method ?? 'GET') === 'HEAD') {
          return new Response(null, {
            status: 401,
            headers: { 'www-authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"` },
          });
        }
        if (url === resourceMetadataUrl) {
          return new Response(
            JSON.stringify({ resource: 'https://apps.lloyal.ai', authorization_servers: [authServer] }),
            { status: 200 },
          );
        }
        if (url === `${authServer}/.well-known/oauth-authorization-server`) {
          return new Response(
            JSON.stringify({
              registration_endpoint: `${authServer}/reg`,
              authorization_endpoint: `${authServer}/auth`,
              token_endpoint: `${authServer}/tok`,
              code_challenge_methods_supported: ['S256'],
            }),
            { status: 200 },
          );
        }
        if (url === `${authServer}/tok` && init?.method === 'POST') {
          return new Response(
            JSON.stringify({ access_token: 'oauth:refreshed', refresh_token: cached.refresh_token, expires_in: 900 }),
            { status: 200 },
          );
        }
        return new Response('not found', { status: 404 });
      }),
    );

    const access = await ensureFreshToken(resourceUrl);
    expect(access).toBe('oauth:refreshed');

    const persisted = JSON.parse(await readFile(__test.cacheFile, 'utf-8')) as OAuthTokens;
    expect(persisted.access_token).toBe('oauth:refreshed');
    expect(persisted.expires_at).toBeGreaterThan(Date.now());
  });
});

// ── Fixtures + helpers ───────────────────────────────────────────

function sampleEndpoints() {
  return {
    registration_endpoint: 'https://lloyal.cloudflareaccess.com/reg',
    authorization_endpoint: 'https://lloyal.cloudflareaccess.com/auth',
    token_endpoint: 'https://lloyal.cloudflareaccess.com/tok',
    resource: 'https://apps.lloyal.ai',
    authorization_server: 'https://lloyal.cloudflareaccess.com',
  };
}

function sampleTokens(): OAuthTokens {
  return {
    access_token: 'oauth:initial-access',
    refresh_token: 'oauth:initial-refresh',
    expires_at: Date.now() + 900_000,
    team_domain: 'lloyal',
    authorization_server: 'https://lloyal.cloudflareaccess.com',
    client_id: 'client-abc-123',
  };
}

function base64UrlEncodeBuf(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
