/**
 * `httpFetch` exists because Node's fetch has no default timeout: a blackholed
 * egress hangs forever instead of failing, and since 0.8.0 every scaffold
 * reaches apps.lloyal.ai — including from CI.
 *
 * The load-bearing design choice is that the deadline covers only the wait for
 * HEADERS. `models.ts` streams multi-gigabyte `.gguf` weights through this, so a
 * whole-request timeout would abort healthy slow downloads. The third test below
 * is the one that pins that down; without it, a later "simplification" to
 * `AbortSignal.timeout` would look correct and silently cap model downloads.
 *
 * Served from a real loopback server rather than a stubbed global — the
 * behaviour under test is timing, which a stub cannot exhibit.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { httpFetch } from '../src/http.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** Start a loopback server with the given handler; resolve its base URL. */
async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${addr.port}`;
}

describe('httpFetch', () => {
  it('returns the response when the server answers', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    const res = await httpFetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('aborts when headers never arrive, naming the host and the recovery', async () => {
    // Accept the connection and never answer — the silent-drop case. A refused
    // or unresolvable host fails fast on its own and needs no deadline.
    const url = await serve(() => {
      /* deliberately never responds */
    });
    await expect(httpFetch(url, {}, 100)).rejects.toThrow(
      /timed out after 100ms waiting for 127\.0\.0\.1:\d+ to respond — check your network or proxy/,
    );
  });

  it('does NOT abort a slow BODY once headers have arrived', async () => {
    // THE REGRESSION GUARD: a multi-GB .gguf download sends headers promptly and
    // then streams for a long time. A whole-request deadline would kill it.
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write('first');
      setTimeout(() => res.end('-last'), 300); // well past the 100ms deadline
    });
    const res = await httpFetch(url, {}, 100);
    expect(await res.text()).toBe('first-last');
  });

  it('passes init through and rethrows non-timeout errors untouched', async () => {
    const url = await serve((req, res) => {
      res.writeHead(200);
      res.end(req.method);
    });
    expect(await (await httpFetch(url, { method: 'HEAD' })).status).toBe(200);

    // Nothing listening on this port → a real connection error, not our abort.
    await expect(httpFetch('http://127.0.0.1:1/none')).rejects.not.toThrow(/timed out/);
  });
});
