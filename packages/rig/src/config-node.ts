/**
 * Config-file mechanics — the disk half of the Runner substrate (hdk#109).
 *
 * ONE audited copy of the behaviors the harness.json persistence layer was
 * review-hardened into (lloyal-ai#14, eight rounds): atomic 0600 writes that
 * tighten a loose file, a version guard that refuses to rebuild over content
 * it cannot understand, ENOENT-only "fresh", `git check-ignore` as the
 * gitignore authority, and boundary path resolution. The per-template
 * LAYERING (which yml keys exist, the rung chain, validation) stays in the
 * scaffold — that part genuinely is the developer's.
 *
 * Node-only (`node:fs`/`node:path`/`node:os`/`node:child_process`) — import
 * from `@lloyal-labs/rig/node`.
 *
 * @category Rig
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Resolve a user-typed path to an absolute path: `~`/`~/x` expand against the
 * home dir, relative resolves against cwd, absolute passes through. Empty
 * input returns ''. Idempotent. Apply at the boundary between user input and
 * persisted/live state; persisted form is always absolute.
 */
export function resolvePath(input: string): string {
  if (!input) return '';
  const expanded =
    input === '~'
      ? os.homedir()
      : input.startsWith('~/')
        ? path.join(os.homedir(), input.slice(2))
        : input;
  return path.resolve(expanded);
}

/** Resolve path-shaped string values in one ability's config object, with no
 *  per-ability name knowledge: a value is a path when its property name ends
 *  in "Path" (case-insensitive) or the string starts with `~`, `/`, or `.`. */
export function resolveAppConfigPaths(
  cfg: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (
      typeof value === 'string' &&
      value !== '' &&
      (/path$/i.test(key) || /^[~/.]/.test(value))
    ) {
      out[key] = resolvePath(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Read a version-1 JSON overlay for the LOADER: absent, unreadable, or
 *  future-versioned ⇒ null — the overlay is ignorable; the layers beneath it
 *  still describe a runnable harness. */
export function readJsonOverlay<T>(p: string): (Partial<T> & { version?: number }) | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<T> & {
      version?: number;
    };
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Read a version-1 JSON file for the WRITER. Unlike the loader, a save must
 *  never rebuild over content it cannot understand — that would destroy a
 *  newer runtime's (or another user's) settings. ONLY a missing file is a
 *  fresh config; not-JSON, version ≠ 1, or any other read failure (EACCES,
 *  EIO) throws with a precise message, leaving the file untouched. */
export function readJsonForWrite<T>(
  p: string,
  displayName: string = path.basename(p),
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
  let parsed: Partial<T> & { version?: number };
  try {
    parsed = JSON.parse(raw) as Partial<T> & { version?: number };
  } catch {
    throw new Error(`${displayName} is not valid JSON — fix or delete it; nothing was saved.`);
  }
  if (parsed.version !== 1) {
    throw new Error(
      `${displayName} is version ${String(parsed.version)}; this harness writes version 1 — not overwriting a newer runtime's settings.`,
    );
  }
  return parsed;
}

/** Write JSON atomically (tmp + rename) with mode 0600: config can carry
 *  credentials, so the file must never be group/world-readable — and because
 *  rename preserves the tmp's mode, every save also TIGHTENS a previously
 *  looser file. Creates the directory if missing. */
export function writeJsonAtomic(p: string, value: unknown): void {
  const resolved = path.resolve(p);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const tmp = resolved + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(tmp, resolved);
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
      execFileSync('git', ['check-ignore', '-q', '--', relative], {
        cwd: repoRoot,
        stdio: 'ignore',
      });
      ignored = true;
    } catch (e) {
      // exit 1 = definitively not ignored; anything else (git missing) =
      // unknown → fall back to the literal check.
      ignored = (e as { status?: number }).status === 1 ? false : null;
    }
    if (ignored === true) return false;
    if (ignored === null) {
      const name = path.basename(configFilePath);
      const needle = new RegExp(
        `(^|\\n)\\s*(${escapeRe(relative)}|${escapeRe(name)})\\s*(\\n|$)`,
      );
      if (needle.test(existing)) return false;
    }
    const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(gitignorePath, prefix + relative + '\n');
    return true;
  } catch {
    return false;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
