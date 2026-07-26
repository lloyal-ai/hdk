/**
 * Collapse a home-prefixed absolute path to `~/...` for display.
 *
 * Browser-safe by design — NO `node:os`/`node:path`, so it can sit in the
 * `reduce` graph that `reasoning.run/state` re-exports (a renderer imports
 * that surface). Reads $HOME/$USERPROFILE from a guarded `process.env` where a
 * `process` global exists (Node), and returns the path unchanged in a browser
 * or for any path outside home. Its inverse — `resolvePath` (`~` expansion for
 * config
 * input, genuinely `node:`) — stays in `./path-utils`, the runner-side module.
 */
export function shortPath(p: string): string {
  if (!p) return p;
  const env = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env;
  const home = env?.HOME ?? env?.USERPROFILE;
  if (
    home &&
    (p === home || p.startsWith(home + "/") || p.startsWith(home + "\\"))
  ) {
    return "~" + p.slice(home.length);
  }
  return p;
}
