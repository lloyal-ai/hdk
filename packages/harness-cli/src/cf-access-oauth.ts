/**
 * Embedded Cloudflare Access OAuth client for `harness.dev publish`.
 *
 * Implements RFC 8252 (OAuth 2.0 for native apps — loopback redirect URI),
 * RFC 7636 (PKCE), RFC 7591 (dynamic client registration), and RFC 9728
 * (OAuth 2.0 protected resource metadata discovery) against Cloudflare
 * Access's Managed OAuth endpoints.
 *
 * This module exists so external app developers running `harness.dev
 * publish` do not need to install a separate vendor CLI (`cloudflared`)
 * just to authenticate. Everything here uses Node built-ins only.
 *
 * Token cache lives at `$XDG_CACHE_HOME/lloyal/auth.json` (defaulting to
 * `~/.cache/lloyal/auth.json` when `XDG_CACHE_HOME` isn't set), mode 0600.
 * The `lloyal/` namespace is shared with the rest of the Lloyal channel
 * caches (installed bundles under `apps/`, downloaded LLM models under
 * `models/`). First run opens a browser; subsequent runs are silent until
 * the access_token expires (and is silently refreshed) or the
 * refresh_token's grant expires.
 *
 * Auth flow against Cloudflare Access:
 *
 *   1. HEAD <resourceUrl>; read `www-authenticate: Bearer
 *      resource_metadata="..."` → fetch the resource metadata JSON.
 *   2. From the resource metadata's `authorization_servers[0]`, fetch
 *      `<auth_server>/.well-known/oauth-authorization-server` →
 *      `{ registration_endpoint, authorization_endpoint, token_endpoint }`.
 *   3. POST RFC 7591 dynamic-client-registration body to
 *      `registration_endpoint` → `{ client_id }`.
 *   4. Generate PKCE pair (code_verifier random, code_challenge =
 *      base64url(sha256(verifier))).
 *   5. Spin up `http.createServer` on `127.0.0.1:<random-port>/callback`,
 *      open browser to authorization URL.
 *   6. Browser redirects to `/callback?code=<code>` after SSO. CLI
 *      captures, server closes.
 *   7. POST `grant_type=authorization_code` with code + verifier + client_id
 *      to `token_endpoint` → `{ access_token, refresh_token, expires_in }`.
 *   8. Cache to disk. Return access_token. Caller sets
 *      `Authorization: Bearer <token>` on the publish POST.
 *
 * @packageDocumentation
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AddressInfo } from 'node:net';

// ── Constants ───────────────────────────────────────────────────────

function defaultCacheDir(): string {
  const xdgCache = process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
  return join(xdgCache, 'lloyal');
}

let cacheDir = defaultCacheDir();
let cacheFile = join(cacheDir, 'auth.json');

/** Time buffer before token expiry at which we proactively refresh. */
const EXPIRY_BUFFER_MS = 60_000;

/** Total time we wait for the user to complete the browser auth flow. */
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

// ── Types ───────────────────────────────────────────────────────────

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  /** Unix ms when the access_token expires. */
  expires_at: number;
  /** The Cloudflare team subdomain (e.g., `lloyal` for `lloyal.cloudflareaccess.com`). */
  team_domain: string;
  /** Full authorization server URL — `https://<team>.cloudflareaccess.com`. */
  authorization_server: string;
  /** client_id from RFC 7591 dynamic client registration; reused across runs. */
  client_id: string;
}

interface AuthServerEndpoints {
  registration_endpoint: string;
  authorization_endpoint: string;
  token_endpoint: string;
  /** From the protected-resource-metadata's `resource` field. */
  resource: string;
  /** From the protected-resource-metadata's `authorization_servers[0]`. */
  authorization_server: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type?: string;
}

// ── Public surface ──────────────────────────────────────────────────

/**
 * Returns a fresh access_token for the given resource URL. Reads the
 * cached tokens; if the access_token is still valid, returns it
 * immediately. If expired, attempts a refresh. If refresh fails (or
 * there's no cache), runs the full loopback OAuth flow (opens a browser).
 * Always saves the resulting tokens back to disk.
 */
export async function ensureFreshToken(resourceUrl: string): Promise<string> {
  const cached = await loadCache();
  if (cached && cached.expires_at - Date.now() > EXPIRY_BUFFER_MS) {
    return cached.access_token;
  }

  const endpoints = await discoverEndpoints(resourceUrl);

  if (cached && cached.refresh_token) {
    try {
      const refreshed = await refreshAccessToken(endpoints, cached);
      await saveCache(refreshed);
      return refreshed.access_token;
    } catch {
      // Fall through to full flow.
    }
  }

  const tokens = await runLoopbackOAuth(endpoints);
  await saveCache(tokens);
  return tokens.access_token;
}

// ── Discovery (RFC 9728 + RFC 8414) ─────────────────────────────────

/**
 * Discover the Cloudflare Access OAuth endpoints for a given protected
 * resource URL. Returns the resolved registration / authorization /
 * token endpoints alongside the resource + authorization-server URLs
 * (the latter is the input to PKCE state and refresh).
 *
 * Visible for testing.
 */
export async function discoverEndpoints(resourceUrl: string): Promise<AuthServerEndpoints> {
  // Step 1: HEAD the resource; expect 401 with www-authenticate header.
  const head = await fetch(resourceUrl, { method: 'HEAD' });
  const wwwAuth = head.headers.get('www-authenticate');
  if (!wwwAuth) {
    throw new Error(
      `Cloudflare Access OAuth discovery failed: HEAD ${resourceUrl} returned no www-authenticate header. ` +
        `Confirm Managed OAuth is enabled on the Access application.`,
    );
  }
  const rmMatch = /resource_metadata="([^"]+)"/.exec(wwwAuth);
  if (!rmMatch) {
    throw new Error(
      `Cloudflare Access OAuth discovery failed: www-authenticate header lacked resource_metadata directive.\n` +
        `  Received: ${wwwAuth}`,
    );
  }
  const resourceMetadataUrl = rmMatch[1];

  // Step 2: Fetch the resource-metadata document (RFC 9728).
  const rmResp = await fetch(resourceMetadataUrl);
  if (!rmResp.ok) {
    throw new Error(
      `Cloudflare Access OAuth discovery: resource-metadata fetch ${resourceMetadataUrl} returned HTTP ${rmResp.status}.`,
    );
  }
  const rm = (await rmResp.json()) as { resource?: string; authorization_servers?: string[] };
  if (!rm.authorization_servers || rm.authorization_servers.length === 0) {
    throw new Error(
      `Cloudflare Access OAuth discovery: resource-metadata at ${resourceMetadataUrl} has no authorization_servers.`,
    );
  }
  const authServer = rm.authorization_servers[0];
  const resource = rm.resource ?? resourceUrl;

  // Step 3: Fetch the authorization-server-metadata document (RFC 8414).
  const wkUrl = `${authServer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`;
  const wkResp = await fetch(wkUrl);
  if (!wkResp.ok) {
    throw new Error(
      `Cloudflare Access OAuth discovery: authorization-server-metadata fetch ${wkUrl} returned HTTP ${wkResp.status}.`,
    );
  }
  const wk = (await wkResp.json()) as {
    registration_endpoint?: string;
    authorization_endpoint?: string;
    token_endpoint?: string;
    code_challenge_methods_supported?: string[];
  };
  if (!wk.registration_endpoint || !wk.authorization_endpoint || !wk.token_endpoint) {
    throw new Error(
      `Cloudflare Access OAuth discovery: authorization-server-metadata at ${wkUrl} missing required endpoints.`,
    );
  }
  if (wk.code_challenge_methods_supported && !wk.code_challenge_methods_supported.includes('S256')) {
    throw new Error(
      `Cloudflare Access OAuth discovery: authorization server does not advertise S256 PKCE support; ` +
        `the embedded client only supports S256.`,
    );
  }
  return {
    registration_endpoint: wk.registration_endpoint,
    authorization_endpoint: wk.authorization_endpoint,
    token_endpoint: wk.token_endpoint,
    resource,
    authorization_server: authServer,
  };
}

// ── Dynamic client registration (RFC 7591) ──────────────────────────

/**
 * Register an OAuth client dynamically with the Cloudflare Access
 * authorization server. The returned client_id is reused across runs
 * (persisted in the auth cache file by {@link runLoopbackOAuth}'s caller).
 *
 * Visible for testing.
 */
export async function registerClient(
  endpoints: AuthServerEndpoints,
  redirectUri: string,
): Promise<string> {
  const resp = await fetch(endpoints.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      resource: endpoints.resource,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Cloudflare Access OAuth dynamic client registration failed: HTTP ${resp.status} from ${endpoints.registration_endpoint}\n${body}`,
    );
  }
  const out = (await resp.json()) as { client_id?: string };
  if (!out.client_id) {
    throw new Error(
      `Cloudflare Access OAuth dynamic client registration: response missing client_id field.`,
    );
  }
  return out.client_id;
}

// ── PKCE (RFC 7636) ─────────────────────────────────────────────────

/**
 * Generate a PKCE code_verifier + code_challenge pair using S256.
 *
 * Cloudflare's docs note the code_challenge MUST start with `[a-zA-Z0-9]`
 * (a `-` or `_` at position 0 breaks their URL parsing). The function
 * re-rolls the verifier until the resulting challenge starts with an
 * alphanumeric character. Expected re-rolls: ~5%.
 *
 * Visible for testing.
 */
export function generatePKCE(): { code_verifier: string; code_challenge: string } {
  for (let attempt = 0; attempt < 10; attempt++) {
    const verifier = base64UrlEncode(randomBytes(32));
    const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest());
    if (/^[a-zA-Z0-9]/.test(challenge)) {
      return { code_verifier: verifier, code_challenge: challenge };
    }
  }
  // Astronomically unlikely (~6e-13 probability), but bail rather than loop forever.
  throw new Error('PKCE generation: failed to produce an alphanumeric-leading code_challenge in 10 attempts');
}

// ── Loopback OAuth flow (RFC 8252) ──────────────────────────────────

/**
 * Run the full RFC 8252 loopback OAuth flow: register client, open
 * browser, capture callback, exchange code for tokens. Returns fresh
 * tokens with the metadata needed for later refresh.
 *
 * Visible for testing.
 */
export async function runLoopbackOAuth(endpoints: AuthServerEndpoints): Promise<OAuthTokens> {
  const { server, port } = await startLoopbackServer();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const clientId = await registerClient(endpoints, redirectUri);
  const { code_verifier, code_challenge } = generatePKCE();

  const authUrl = new URL(endpoints.authorization_endpoint);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('code_challenge', code_challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('resource', endpoints.resource);

  process.stderr.write(
    `harness.dev publish: opening browser for Cloudflare Access SSO...\n` +
      `  If the browser doesn't open automatically, visit:\n  ${authUrl.toString()}\n`,
  );

  openBrowser(authUrl.toString());

  let code: string;
  try {
    code = await awaitCallbackCode(server);
  } finally {
    server.close();
  }

  const tokenResp = await exchangeCodeForTokens(endpoints, {
    code,
    code_verifier,
    client_id: clientId,
    redirect_uri: redirectUri,
  });

  if (!tokenResp.refresh_token) {
    throw new Error(
      `Cloudflare Access OAuth token exchange: response missing refresh_token. ` +
        `Confirm refresh tokens are enabled on the Managed OAuth application.`,
    );
  }

  return {
    access_token: tokenResp.access_token,
    refresh_token: tokenResp.refresh_token,
    expires_at: Date.now() + tokenResp.expires_in * 1000,
    team_domain: teamDomainFromAuthServer(endpoints.authorization_server),
    authorization_server: endpoints.authorization_server,
    client_id: clientId,
  };
}

/**
 * Refresh an access_token using a previously-issued refresh_token
 * (RFC 6749 §6). Reuses the same client_id from the original
 * dynamic-registration call.
 *
 * Visible for testing.
 */
export async function refreshAccessToken(
  endpoints: AuthServerEndpoints,
  existing: OAuthTokens,
): Promise<OAuthTokens> {
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', existing.refresh_token);
  body.set('client_id', existing.client_id);

  const resp = await fetch(endpoints.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Cloudflare Access OAuth refresh failed: HTTP ${resp.status} from ${endpoints.token_endpoint}\n${text}`,
    );
  }
  const tok = (await resp.json()) as TokenResponse;
  return {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? existing.refresh_token,
    expires_at: Date.now() + tok.expires_in * 1000,
    team_domain: existing.team_domain,
    authorization_server: existing.authorization_server,
    client_id: existing.client_id,
  };
}

// ── Internals ───────────────────────────────────────────────────────

async function exchangeCodeForTokens(
  endpoints: AuthServerEndpoints,
  params: { code: string; code_verifier: string; client_id: string; redirect_uri: string },
): Promise<TokenResponse> {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', params.code);
  body.set('code_verifier', params.code_verifier);
  body.set('client_id', params.client_id);
  body.set('redirect_uri', params.redirect_uri);

  const resp = await fetch(endpoints.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Cloudflare Access OAuth token exchange failed: HTTP ${resp.status} from ${endpoints.token_endpoint}\n${text}`,
    );
  }
  return (await resp.json()) as TokenResponse;
}

async function startLoopbackServer(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  return { server, port: addr.port };
}

async function awaitCallbackCode(server: Server): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Cloudflare Access OAuth: no callback received within ${AUTH_TIMEOUT_MS / 1000}s`));
    }, AUTH_TIMEOUT_MS);

    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('not found');
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (error) {
        const desc = url.searchParams.get('error_description') ?? '';
        res
          .writeHead(400, { 'content-type': 'text/html' })
          .end(`<html><body><h1>Authentication failed</h1><p>${escapeHtml(error)}: ${escapeHtml(desc)}</p></body></html>`);
        clearTimeout(timeout);
        reject(new Error(`Cloudflare Access OAuth: authorization server returned ${error}: ${desc}`));
        return;
      }
      if (!code) {
        res.writeHead(400).end('missing code');
        return;
      }
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<html><body><h1>Authenticated</h1><p>You can close this tab and return to the terminal.</p></body></html>',
        );
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['', url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
    child.unref();
  } catch {
    // Browser-open is best-effort; the URL is also printed to stderr.
  }
}

function teamDomainFromAuthServer(authServer: string): string {
  const m = /^https?:\/\/([^.]+)\.cloudflareaccess\.com/.exec(authServer);
  return m ? m[1] : authServer;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

// ── Cache I/O ───────────────────────────────────────────────────────

async function loadCache(): Promise<OAuthTokens | null> {
  try {
    const raw = await readFile(cacheFile, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<OAuthTokens>;
    if (
      typeof parsed.access_token === 'string' &&
      typeof parsed.refresh_token === 'string' &&
      typeof parsed.expires_at === 'number' &&
      typeof parsed.team_domain === 'string' &&
      typeof parsed.authorization_server === 'string' &&
      typeof parsed.client_id === 'string'
    ) {
      return parsed as OAuthTokens;
    }
    return null;
  } catch {
    return null;
  }
}

async function saveCache(tokens: OAuthTokens): Promise<void> {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const tmp = cacheFile + '.tmp';
  await writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  await rename(tmp, cacheFile);
}

// ── Test-only helpers ───────────────────────────────────────────────

/**
 * Test-only: overrides the cache-file path so unit tests don't touch
 * the user's real `~/.cache/lloyal/auth.json`.
 *
 * @internal
 */
export const __test = {
  setCachePath(dir: string): void {
    cacheDir = dir;
    cacheFile = join(dir, 'auth.json');
  },
  resetCachePath(): void {
    cacheDir = defaultCacheDir();
    cacheFile = join(cacheDir, 'auth.json');
  },
  get cacheFile() {
    return cacheFile;
  },
};
