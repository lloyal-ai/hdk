/**
 * A library's folder mechanics: a name minted and its folder reserved in one
 * exclusive step, a client-supplied path confined to the library by its real
 * location, a listing held to the same rule, and removal. What a folder holds
 * and when it is settled is the app's; how a folder is reserved, confined and
 * removed is here, so the edges (which failures retry, how many times, what a
 * planted symlink can reach) are testable on their own.
 *
 * Node only: `node:fs`, `node:crypto`.
 *
 * @category Rig
 */
import { webcrypto } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** How many fresh names `reserveFolder` tries before refusing. A UUID collides
 *  in theory only; the bound exists so a forced one is refused, not looped. */
export const RESERVE_ATTEMPTS = 4;

/** The one name mint: an ISO stamp for sorting and reading, then a UUID so two
 *  mints never name one folder — in one millisecond, in one session or two.
 *  URL-safe and filename-safe as minted. `randomUUID` is read off `webcrypto`
 *  at each call, so a test can force a collision. */
export function mintFolderName(now: Date = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, '-').replace('Z', '')}-${webcrypto.randomUUID()}`;
}

/**
 * Mint a name and reserve its folder in one step. The root is created first
 * (recursively; it may not exist yet); the folder itself non-recursively, so
 * `EEXIST` — another session, a planted fixture, a forced clock — means try
 * again with a fresh name. Any other failure is the root's, not the name's,
 * and is thrown at once. After `attempts` collisions it refuses, having
 * created nothing. Returns the name; the folder is `root/<name>`.
 */
export function reserveFolder(root: string, opts: { mint?: () => string; attempts?: number } = {}): string {
  const mint = opts.mint ?? mintFolderName;
  const attempts = opts.attempts ?? RESERVE_ATTEMPTS;
  fs.mkdirSync(root, { recursive: true });
  for (let attempt = 0; attempt < attempts; attempt++) {
    const name = mint();
    try {
      fs.mkdirSync(path.join(root, name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    return name;
  }
  throw new Error(`could not reserve a folder after ${attempts} attempts`);
}

/**
 * A client-supplied path is trusted only once its REAL location (symlinks
 * resolved) is a regular file exactly one folder below the root's real
 * location. Realpath on both sides, so a planted link cannot lead a read
 * outside the library; the depth rule keeps a removal of the file's folder
 * aimed at a reserved folder, never the root itself nor some deeper tree.
 * Returns the real path, or null: not the library's.
 */
export function confined(root: string, candidate: string): string | null {
  try {
    const realRoot = fs.realpathSync(path.resolve(root));
    const real = fs.realpathSync(path.resolve(candidate));
    return path.dirname(path.dirname(real)) === realRoot && fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** The folders directly under the root that hold a confined `marker` file, by
 *  name, each with the marker's real path. A symlinked folder surfaces nothing.
 *  A missing root lists nothing. */
export function listFolders(root: string, marker: string): { name: string; path: string }[] {
  if (!fs.existsSync(root)) return [];
  const found: { name: string; path: string }[] = [];
  for (const name of fs.readdirSync(root).sort()) {
    const real = confined(root, path.join(root, name, marker));
    if (real !== null) found.push({ name, path: real });
  }
  return found;
}

/** Remove a folder with everything in it. A missing folder is nothing to do. */
export function removeFolder(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
