/**
 * Config-file mechanics — the disk half of the Runner substrate (hdk#109).
 *
 * ONE audited copy of the behaviors the harness.json persistence layer was
 * review-hardened into (lloyal-ai#14, eight rounds): atomic 0600 writes that
 * tighten a loose file, a version guard that refuses to rebuild over content
 * it cannot understand, ENOENT-only "fresh", `git check-ignore` as the
 * gitignore authority, and boundary path resolution. The LAYERING (which
 * keys exist, the rung chain, validation) is `config-layering`, run from the
 * table an app declares with `defineConfig`.
 *
 * Node-only (`node:fs`/`node:path`/`node:os`/`node:child_process`) — import
 * from `@lloyal-labs/rig/node`.
 *
 * @category Rig
 */
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CONFIG_VERSION } from './config';
import { isBag } from './config-paths';
import type { Bag } from './config-paths';

/**
 * Resolve a user-typed path to an absolute path: `~`/`~/x` expand against the
 * home dir, relative resolves against cwd, absolute passes through. Empty
 * input returns ''. Idempotent. Apply at the boundary between user input and
 * persisted/live state; persisted form is always absolute.
 */
export function resolvePath(input: string, base: string = process.cwd()): string {
  if (!input) return '';
  const expanded =
    input === '~'
      ? os.homedir()
      : input.startsWith('~/')
        ? path.join(os.homedir(), input.slice(2))
        : input;
  return path.resolve(base, expanded);
}

/** The ONE definition of "this ability config value is a path", with no
 *  per-ability name knowledge: the property name ends in "Path"
 *  (case-insensitive) or the string starts with `~`, `/`, or `.`. The resolver
 *  resolves by it and the settings group checks existence by it, so the two
 *  cannot drift. */
export function isPathShaped(key: string, value: unknown): value is string {
  return typeof value === 'string' && value !== '' && (/path$/i.test(key) || /^[~/.]/.test(value));
}

/** Resolve path-shaped string values in one ability's config object, by {@link isPathShaped}, against `base`. */
export function resolveAppConfigPaths(
  cfg: Record<string, unknown>,
  base: string = process.cwd(),
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg)) {
    out[key] = isPathShaped(key, value) ? resolvePath(value, base) : value;
  }
  return out;
}

/** Where version 1 wrote each model key, flat under `model`, and the block it lives in now. Exported so a mirror
 *  of it elsewhere (the CLI reads `harness.json` without depending on rig) can be held to it. */
export const V1_MODEL_KEYS: Record<string, [block: string, key: string]> = {
  id: ['llm', 'id'], path: ['llm', 'path'], nCtx: ['llm', 'context'], gpu: ['llm', 'gpu'], branches: ['llm', 'branches'], kvCache: ['llm', 'kvCache'],
  reranker: ['reranker', 'path'], rerankerId: ['reranker', 'id'],
  mmproj: ['vision', 'id'], imageMinTokens: ['vision', 'minTokens'], imageMaxTokens: ['vision', 'maxTokens'],
};

/** Where a one-line note about a migrated file goes. Default: stderr. */
export type Say = (line: string) => void;
const toStderr: Say = (line) => { process.stderr.write(`${line}\n`); };

/**
 * A version-1 file at the current version: its flat model keys moved into their blocks, every other key kept.
 * The migration preserves what version 1 MEANT, because in version 2 a block's presence requests a model:
 * a value version 1 had cleared (`""`, `null`) migrates to absence, never to a request with an empty selection;
 * vision tuning under a catalog llm keeps its block, which is what version 1 did (the projector paired
 * implicitly); under a `path:` llm the tuning keys are dropped — version 1 paired no projector there either,
 * and version 2 would refuse the request — and `say` hears which, once. Pure otherwise — the loader reads the
 * result, the writer merges over it, and the next save writes it.
 */
function migrateV1<T>(parsed: Partial<T> & { version?: number }, say: Say): Partial<T> & { version?: number } {
  const model = (parsed as Bag).model;
  if (!isBag(model)) return { ...parsed, version: CONFIG_VERSION };
  const cleared = (v: unknown): boolean => v === '' || v === null;
  const pathLlm = typeof model.path === 'string' && model.path !== '';
  const projector = !cleared(model.mmproj) && model.mmproj !== undefined;
  const next: Bag = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(model)) {
    const moved = V1_MODEL_KEYS[key];
    if (!moved) { next[key] = value; continue; }
    if (cleared(value)) continue;
    const [block, at] = moved;
    if (block === 'vision' && key !== 'mmproj' && pathLlm && !projector) { dropped.push(key); continue; }
    next[block] = { ...((next[block] as Bag | undefined) ?? {}), [at]: value };
  }
  if (dropped.length > 0) say(`harness.json: ${dropped.join(', ')} dropped — version 1 paired no projector with a \`path:\` model, and version 2 would request one`);
  return { ...parsed, version: CONFIG_VERSION, model: next } as Partial<T> & { version?: number };
}

/** A parsed file at the current version, or null when this runtime does not write the version it carries. */
function atCurrentVersion<T>(parsed: unknown, say: Say): (Partial<T> & { version?: number }) | null {
  if (parsed === null || typeof parsed !== 'object') return null;
  const file = parsed as Partial<T> & { version?: number };
  if (file.version === CONFIG_VERSION) return file;
  if (file.version === 1) return migrateV1(file, say);
  return null;
}

/** Read the JSON overlay for the LOADER: absent, unreadable, or
 *  future-versioned ⇒ null — the overlay is ignorable; the layers beneath it
 *  still describe a runnable harness. A version-1 file is read migrated. */
export function readJsonOverlay<T>(p: string, say: Say = toStderr): (Partial<T> & { version?: number }) | null {
  try {
    return atCurrentVersion<T>(JSON.parse(fs.readFileSync(p, 'utf8')), say);
  } catch {
    return null;
  }
}

/** Read the JSON file for the WRITER. Unlike the loader, a save must
 *  never rebuild over content it cannot understand — that would destroy a
 *  newer runtime's (or another user's) settings. ONLY a missing file is a
 *  fresh config; not-JSON, a version this runtime does not write, or any other
 *  read failure (EACCES, EIO) throws with a precise message, leaving the file
 *  untouched. A version-1 file is handed over migrated, so the save writes it
 *  at the current version. */
export function readJsonForWrite<T>(
  p: string,
  displayName: string = path.basename(p),
  say: Say = toStderr,
): (Partial<T> & { version?: number }) | null {
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `${displayName} exists but cannot be read (${(err as NodeJS.ErrnoException).code ?? 'unknown'}) — nothing was saved.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${displayName} is not valid JSON — fix or delete it; nothing was saved.`);
  }
  const current = atCurrentVersion<T>(parsed, say);
  if (!current) {
    const version = parsed === null || typeof parsed !== 'object' ? undefined : (parsed as { version?: number }).version;
    throw new Error(
      `${displayName} is version ${String(version)}; this harness writes version ${CONFIG_VERSION} — not overwriting a newer runtime's settings.`,
    );
  }
  return current;
}

/** Write JSON atomically (tmp + rename) with mode 0600: config can carry
 *  credentials, so the file must never be group/world-readable — and because
 *  rename preserves the tmp's mode, every save also TIGHTENS a previously
 *  looser file. Creates the directory if missing. */
export function writeJsonAtomic(p: string, value: unknown): void {
  const resolved = path.resolve(p);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  // Random suffix + 'wx' (O_CREAT|O_EXCL): the tmp is always a FRESH inode we
  // own — an attacker-planted file or symlink at a guessed name makes the
  // write FAIL instead of following the link or inheriting a loose mode.
  const tmp =
    resolved + '.tmp-' + crypto.randomBytes(8).toString('hex');
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(tmp, resolved);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** If the file's directory (or an ancestor) is a git repo, append the file to
 *  the nearest `.gitignore` iff Git doesn't already ignore it.
 *  `git check-ignore` is the authority (wildcards, anchored patterns, global
 *  excludes); when git isn't runnable, a literal line-match is the
 *  conservative fallback. Returns true only when a write happened — at most
 *  once per repo. */
export function maybeAppendGitignore(configFilePath: string): boolean {
  try {
    const repoRoot = findGitRoot(path.dirname(configFilePath));
    if (!repoRoot) return false;
    const gitignorePath = path.join(repoRoot, '.gitignore');
    const relative = path.relative(repoRoot, configFilePath).replace(/\\/g, '/');
    const existing = fs.existsSync(gitignorePath)
      ? fs.readFileSync(gitignorePath, 'utf8')
      : '';
    let ignored: boolean | null = null;
    try {
      // --no-index: evaluate the ignore RULES alone. Without it a TRACKED
      // config file is never reported ignored (exit 1 on every save), and the
      // same line would be appended again each time.
      execFileSync('git', ['check-ignore', '-q', '--no-index', '--', relative], {
        cwd: repoRoot,
        stdio: 'ignore',
      });
      ignored = true;
    } catch (e) {
      // exit 1 = definitively not ignored; anything else (git missing) =
      // unknown → the literal check below is the only authority.
      ignored = (e as { status?: number }).status === 1 ? false : null;
    }
    if (ignored === true) return false;
    // A gitignore line is a PATTERN, not a pathname: metacharacters must be
    // escaped or `sub/[dev]/harness.json` ignores `sub/d/…`, never the literal
    // path. Dedup against the escaped form only — a raw unescaped line in the
    // file is ineffective and must not suppress the effective append.
    const line = escapeGitignore(relative);
    // Never append a line that is already there, whatever git said. Leading
    // whitespace is PART of a gitignore pattern (an indented line ignores
    // nothing), so the match allows none; trailing spaces git strips.
    const nameLine = escapeGitignore(path.basename(configFilePath));
    const needle = new RegExp(
      `(^|\\n)(${escapeRe(line)}|${escapeRe(nameLine)})[ \\t]*\\r?(\\n|$)`,
    );
    if (needle.test(existing)) return false;
    const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(gitignorePath, prefix + line + '\n');
    return true;
  } catch {
    return false;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Escape a literal pathname into a gitignore PATTERN: backslash the fnmatch
 *  metacharacters, and a leading `#` (comment) or `!` (negation). */
function escapeGitignore(p: string): string {
  const escaped = p.replace(/([\\[\]*?])/g, '\\$1');
  return /^[#!]/.test(escaped) ? '\\' + escaped : escaped;
}

function findGitRoot(start: string): string | null {
  let cur = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
